// The soft kernel as a solver of the physics framework (docs/physics-framework.md, sections 4, 5 and 8): the `SoftBodies` of a
// `Physics` that a `RigidSolver` steps, stepped by the world. Each step is the soft step `Physics.step()` ran before the rigid
// kernel's, so cloth, ropes, cells and their contacts with rigid bodies are what they were, and a world couples the two with
// `world.couple(['soft', 'rigid'], 'staggered')`: the soft step meets the bodies where the tick began and its push lands in
// that tick's rigid step, as inside `Physics.step()`. Added to a world, the Physics attachment's own soft step does nothing,
// so nothing steps twice.
//
// Fields. The solver reads `bodies` and accumulates into `bodyImpulses` and `bodyForces`, the rigid solver's fields, as every
// solver that pushes on bodies does: a push on a body lands as an impulse at the start of the rigid step (with the spin
// change as the angular impulse that gives it through the body's inertia there) and a force held over that step, which the
// rigid solver takes off after it. The same numbers `Physics.step()` hands the bodies through the body API.
//
// State. Every column of the soft kernel, named by column and row count, in the kernel's own memory until the framework's
// solvers share one (`Region.memory`, transitional). Nothing is held from one tick to the next beyond the kernel: the rigid
// solver lets go of the forces in the step they are for. A snapshot restores into the same soft bodies (their particles,
// edges and cells): the kernel's counts are structure, not state.
import { MargoError } from '@margoengine/math/errors';
import type { SoftBodies } from '../../soft.js';
import type { Port, RateLevel, Region, Solver, SolverDescription, SolverHost, StepContext } from '../solver.js';
import {
  BODIES_FIELD,
  BODY_FORCES_FIELD,
  BODY_IMPULSES_FIELD,
  FORCE_WORDS,
  IMPULSE_WORDS,
  rateLevelOf,
} from './rigid.js';

/** The layout version of the `impulses` and `forces` port regions. */
const SOFT_LAYOUT = 2;

/** What a {@link SoftSolver} is made from. */
export interface SoftSolverParams {
  /** The soft bodies to step: those of the `Physics` a `RigidSolver` of the same world steps. */
  readonly soft: SoftBodies;
  /** Body rows the ports cover (default the rigid kernel's body capacity at `init`). A push past them throws. */
  readonly capacity?: number;
}

/** FNV-1a of the soft kernel's column table (names and element types): the layout version of its state regions. */
function columnTableVersion(columns: readonly [string, Float32Array | Uint32Array][]): number {
  let hash = 0x811c9dc5;
  for (const [name, view] of columns)
    for (const char of `${name}:${view instanceof Float32Array ? 'f' : 'u'};`)
      hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return hash;
}

/** The soft kernel as a framework solver. `id` is `'soft'` unless a world holds more than one. */
export class SoftSolver implements Solver<SoftSolverParams> {
  private soft: SoftBodies | null = null;
  private step0 = 0;
  private host: SolverHost | null = null;
  private level: RateLevel = 0;
  private impulses: Region | null = null;
  private forces: Region | null = null;
  private capacity = 0;

  constructor(readonly id = 'soft') {}

  describe(): SolverDescription {
    const level = this.soft ? this.level : 0;
    return {
      id: this.id,
      fields: [
        { field: BODIES_FIELD, access: 'read' },
        { field: BODY_IMPULSES_FIELD, access: 'accumulate' },
        { field: BODY_FORCES_FIELD, access: 'accumulate' },
      ],
      rate: level,
      // Asked after init, which sets the level (describe comes first, before the Physics is known).
      stableRate: () => (this.soft ? this.level : 0),
    };
  }

  init(host: SolverHost, params: SoftSolverParams): void {
    const soft = params?.soft;
    if (!soft || typeof soft.stepOnce !== 'function')
      throw new TypeError('A SoftSolver is made from a SoftBodies: world.add(new SoftSolver(), {soft}).');
    const physics = soft.drive();
    this.level = rateLevelOf(physics.fixedTimestep);
    this.step0 = physics.fixedTimestep;
    const capacity = params.capacity ?? physics.kernel.capacity;
    if (!(Number.isInteger(capacity) && capacity > 0))
      throw new RangeError(`A SoftSolver's capacity is a whole number of body rows above 0; got ${capacity}.`);
    this.capacity = capacity;
    this.impulses = host.allocate('impulses', capacity * IMPULSE_WORDS * 8, 'f64', SOFT_LAYOUT);
    this.forces = host.allocate('forces', capacity * FORCE_WORDS * 8, 'f64', SOFT_LAYOUT);
    this.host = host;
    this.soft = soft;
  }

  private live(): SoftBodies {
    if (!this.soft)
      throw new MargoError('state', 'SoftSolver is not in a world yet; add it with world.add(solver, {soft}).');
    return this.soft;
  }

  /** A port region's words, a view taken afresh (another solver's allocation may have grown the world's memory). */
  private words(region: Region): Float64Array {
    return new Float64Array(this.host!.memory.buffer, region.byteOffset, region.byteLength / 8);
  }

  step(_context: StepContext, dt: number): void {
    const soft = this.live();
    if (dt !== this.step0)
      throw new MargoError(
        'state',
        `SoftSolver steps ${this.step0} s, and the world asked for ${dt} s; keep the Physics's fixedTimestep as it was added.`,
      );
    const impulses = this.words(this.impulses!),
      forces = this.words(this.forces!);
    impulses.fill(0);
    forces.fill(0);
    soft.stepOnce(dt, { impulses, forces });
  }

  /** The solver's contributions: the impulses at the start of the rigid step and the forces held over it. */
  exportPorts(tick: number): readonly Port[] {
    this.live();
    return [
      { field: BODY_IMPULSES_FIELD.name, region: this.impulses!, tick, cell: [0, 0, 0] },
      { field: BODY_FORCES_FIELD.name, region: this.forces!, tick, cell: [0, 0, 0] },
    ];
  }

  importPorts(_tick: number): void {}

  /** Every soft kernel column, named by column and row count, in the kernel's own memory (transitional). */
  stateRegions(): readonly Region[] {
    const soft = this.live(),
      columns = soft.stateColumns(),
      layout = columnTableVersion(columns),
      memory = soft.kernelMemory;
    return [
      ...columns.map(([name, view]) => ({
        name: `${name}[${view.length}]`,
        byteOffset: view.byteOffset,
        byteLength: view.byteLength,
        type: view instanceof Float32Array ? ('f32' as const) : ('u32' as const),
        layout,
        memory,
      })),
    ];
  }

  extraState(): readonly Region[] {
    return [];
  }
}
