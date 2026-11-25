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
// State: none. Each step's load and added mass come from where the bodies are and the sea at that time.
import { MargoError } from '@margoengine/math/errors';
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
  readonly sea: SeaQuery;
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
}

/** The layout version of the `forces` port region. */
const HULL_LAYOUT = 1;

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
      stableRate: () => level,
    };
  }

  init(host: SolverHost, params: HullParams): void {
    const { hulls, sea, level = 0 } = params ?? ({} as HullParams);
    if (!Array.isArray(hulls) || hulls.length === 0)
      throw new TypeError(
        'A HullSolver floats one or more hulls: world.add(new HullSolver(), {hulls: [{row, mesh}], sea}).',
      );
    if (!sea || typeof sea.elevation !== 'function')
      throw new TypeError('A HullSolver needs a sea with elevation(x, z, t): pass {sea}.');
    for (const hull of hulls) {
      if (!(Number.isInteger(hull.row) && hull.row >= 0))
        throw new RangeError(`A hull's row is a kernel body row, a whole number of 0 or more (got ${hull.row}).`);
      const { vertices, indices } = hull.mesh ?? {};
      if (!vertices || !indices || vertices.length % 3 !== 0 || indices.length % 3 !== 0 || indices.length === 0)
        throw new RangeError(
          'A hull mesh has vertices (three numbers each) and triangles (three indices each, wound outward).',
        );
      for (let k = 0; k < indices.length; k++)
        if (!(Number.isInteger(indices[k]) && indices[k]! >= 0 && indices[k]! < vertices.length / 3))
          throw new RangeError(`Hull triangle index ${indices[k]} names no vertex of the ${vertices.length / 3}.`);
    }
    const capacity = params.capacity ?? Math.max(...hulls.map((h) => h.row)) + 1;
    if (!(Number.isInteger(capacity) && hulls.every((h) => h.row < capacity)))
      throw new RangeError(`A HullSolver's capacity covers every hull's row (got ${capacity}).`);
    this.capacity = capacity;
    this.hulls = hulls;
    this.sea = sea;
    this.level = level;
    this.gravity = params.gravity ?? [0, -GRAVITY, 0];
    this.addedMass = params.addedMass ?? true;
    this.stations = params.stations ?? 24;
    if (!(Number.isInteger(this.stations) && this.stations >= 2))
      throw new RangeError(`A hull has 2 or more stations (got ${this.stations}).`);
    this.host = host;
    this.forces = host.allocate('forces', capacity * FORCE_WORDS * 8, 'f64', HULL_LAYOUT);
  }

  step(context: StepContext, dt: number): void {
    const host = this.host;
    if (!host || !this.sea || !this.forces)
      throw new MargoError('state', 'HullSolver is not in a world yet; add it with world.add(solver, {hulls, sea}).');
    const out = new Float64Array(host.memory.buffer, this.forces.byteOffset, this.capacity * FORCE_WORDS);
    out.fill(0);
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
      const pose = {
          position: [bodies[at]!, bodies[at + 1]!, bodies[at + 2]!] as const,
          rotation: [bodies[at + 3]!, bodies[at + 4]!, bodies[at + 5]!, bodies[at + 6]!] as const,
        },
        centre = [bodies[at + 7]!, bodies[at + 8]!, bodies[at + 9]!] as const,
        loads = wettedLoads(hull.mesh, pose, this.sea, t, centre, this.loads),
        w = hull.row * FORCE_WORDS,
        held = this.addedMass
          ? this.carried(hull, bodies, at, pose, centre, t, loads)
          : [...loads.force, ...loads.torque];
      for (let k = 0; k < 6; k++) out[w + k]! += held[k]!;
    }
  }

  /**
   * The load to hold so the body moves as the hull and the water it carries: M (M + A)^-1 (F + W) - W in world axes about
   * the centre of mass, A the added mass of the sections under the waterline the hull floats at now.
   */
  private carried(
    hull: Hull,
    bodies: Float32Array,
    at: number,
    pose: { readonly position: Vec3; readonly rotation: readonly [number, number, number, number] },
    centre: Vec3,
    t: number,
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
      body = addedMassInfinite(hullSections(hull.mesh, waterline, this.stations), local, density);
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
    for (let k = 0; k < 6; k++) rhs[k] = f[k]! + weight[k]!;
    const acceleration = solve6(system, rhs),
      held: number[] = [];
    for (let i = 0; i < 6; i++) {
      let sum = 0;
      for (let j = 0; j < 6; j++) sum += m[i * 6 + j]! * acceleration[j]!;
      held.push(sum - weight[i]!);
    }
    return held;
  }

  exportPorts(tick: number): readonly Port[] {
    if (!this.forces)
      throw new MargoError('state', 'HullSolver is not in a world yet; add it with world.add(solver, {hulls, sea}).');
    return [{ field: BODY_FORCES_FIELD.name, region: this.forces, tick, cell: [0, 0, 0] }];
  }

  importPorts(_tick: number): void {}

  stateRegions(): readonly Region[] {
    return [];
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
