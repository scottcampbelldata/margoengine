// The soft kernel as a solver of the physics framework (docs/physics-framework.md, sections 4, 5 and 8): the `SoftBodies` of a
// `Physics` that a `RigidSolver` steps, stepped by the world. Each step is the soft step `Physics.step()` ran before the rigid
// kernel's, so cloth, ropes, cells and their contacts with rigid bodies are what they were, and a world couples the two with
// `world.couple(['soft', 'rigid'], 'staggered')`: the soft step meets the bodies where the tick began and its push lands in
// that tick's rigid step, as inside `Physics.step()`. Added to a world, the Physics attachment's own soft step does nothing,
// so nothing steps twice.
//
// Fields. The solver reads `bodies` and accumulates into `bodyImpulses`, the rigid solver's fields, as every solver that
// pushes on bodies does. Transitional: the push itself still goes through the body API (an impulse at the start of the
// rigid step, a force held over it and taken off at the next soft step, and the spin change set directly), because
// `bodyImpulses` alone (an impulse at the step's start) cannot carry the held force or the spin change bit for bit; the port
// it exports holds zeros. A held-force accumulator beside `bodyImpulses` moves it onto the ports (docs/limits.md).
//
// State. Every column of the soft kernel, named by column and row count, in the kernel's own memory until the framework's
// solvers share one (`Region.memory`, transitional), and the forces the last step left on the rigid bodies (`held`, six f64
// a body row: force then torque), so a restored world takes off what it left. A snapshot restores into the same soft bodies
// (their particles, edges and cells): the kernel's counts are structure, not state.
import { MargoError } from '@margoengine/math/errors';
import type { SoftBodies } from '../../soft.js';
import type { Port, RateLevel, Region, Solver, SolverDescription, SolverHost, StepContext } from '../solver.js';
import { BODIES_FIELD, BODY_IMPULSES_FIELD, IMPULSE_WORDS, rateLevelOf } from './rigid.js';

/** f64 words a body row of the `held` state region: the force (N) then the torque (N m) the last soft step left on it. */
const HELD_WORDS = 6;
/** The layout version of the `held` and `impulses` regions. */
const SOFT_LAYOUT = 1;

/** What a {@link SoftSolver} is made from. */
export interface SoftSolverParams {
  /** The soft bodies to step: those of the `Physics` a `RigidSolver` of the same world steps. */
  readonly soft: SoftBodies;
  /** Body rows the held forces cover (default the rigid kernel's body capacity at `init`). A push past them throws. */
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
  private held: Region | null = null;
  private impulses: Region | null = null;
  private capacity = 0;

  constructor(readonly id = 'soft') {}

  describe(): SolverDescription {
    const level = this.soft ? this.level : 0;
    return {
      id: this.id,
      fields: [
        { field: BODIES_FIELD, access: 'read' },
        { field: BODY_IMPULSES_FIELD, access: 'accumulate' },
      ],
      rate: level,
      stableRate: () => level,
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
    this.held = host.allocate('held', capacity * HELD_WORDS * 8, 'f64', SOFT_LAYOUT);
    this.impulses = host.allocate('impulses', IMPULSE_WORDS * 8, 'f64', SOFT_LAYOUT);
    this.host = host;
    this.soft = soft;
  }

  private live(): SoftBodies {
    if (!this.soft)
      throw new MargoError('state', 'SoftSolver is not in a world yet; add it with world.add(solver, {soft}).');
    return this.soft;
  }

  /** The held forces, a view taken afresh (another solver's allocation may have grown the world's memory). */
  private heldWords(): Float64Array {
    return new Float64Array(this.host!.memory.buffer, this.held!.byteOffset, this.capacity * HELD_WORDS);
  }

  step(_context: StepContext, dt: number): void {
    const soft = this.live();
    if (dt !== this.step0)
      throw new MargoError(
        'state',
        `SoftSolver steps ${this.step0} s, and the world asked for ${dt} s; keep the Physics's fixedTimestep as it was added.`,
      );
    soft.loadHeld(this.heldWords());
    soft.stepOnce(dt);
    soft.storeHeld(this.heldWords());
  }

  /** The solver's contribution to `bodyImpulses`: zeros, while the push goes through the body API (transitional). */
  exportPorts(tick: number): readonly Port[] {
    this.live();
    return [{ field: BODY_IMPULSES_FIELD.name, region: this.impulses!, tick, cell: [0, 0, 0] }];
  }

  importPorts(_tick: number): void {}

  /** Every soft kernel column, named by column and row count, in the kernel's own memory (transitional), and the held forces. */
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
      this.held!,
    ];
  }

  extraState(): readonly Region[] {
    return [];
  }
}
