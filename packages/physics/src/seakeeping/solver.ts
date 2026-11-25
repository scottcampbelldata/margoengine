// The water's load on rigid hulls as a solver of the physics framework (docs/physics-framework.md, sections 4 and 5; SEA-08):
// each step it reads where each hull's body is from the rigid solver's `bodies` port, integrates the water's pressure over the
// hull's wetted surface at the middle of the step (wetted.ts), and holds the body with that force and its moment about the
// centre of mass over the rigid solver's next step through `bodyForces`. A world couples it before the rigid solver:
// `world.couple(['hull', 'rigid'], 'staggered')`.
//
// State: none. Each step's load comes from where the bodies are and the sea at that time.
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
import { type HullMesh, type SeaQuery, type WettedLoads, wettedLoads } from './wetted.js';

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
        w = hull.row * FORCE_WORDS;
      out[w]! += loads.force[0];
      out[w + 1]! += loads.force[1];
      out[w + 2]! += loads.force[2];
      out[w + 3]! += loads.torque[0];
      out[w + 4]! += loads.torque[1];
      out[w + 5]! += loads.torque[2];
    }
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
