// The air's loads on rigid bodies as a solver of the physics framework (docs/physics-framework.md, sections 4 and 5): the
// `WindForce`, `WingForce`, `RotorForce` and `LiftingGas` loads of a `Physics` that a `RigidSolver` steps, stepped by the world
// and handed to the rigid solver through `bodyForces`, which holds them over its next step only. A world couples it before
// the rigid solver, `world.couple(['air', 'rigid'], 'staggered')`: the loads meet the bodies where the tick begins, as inside
// `Physics.step()`, and the Physics's own step leaves them alone, so a world and Physics stepped alone are the same bits.
//
// The loads read the bodies through the Physics they were made on (their colliders' surfaces, mass and inertia), as the soft
// solver does; a `beforestep` listener that moves a dynamic body acts after the loads in a world and before them alone.
//
// State: none. Each step's loads come from where the bodies are, the air and the time.
import { MargoError } from '@margoengine/math/errors';
import { type AirHold, airHoldOf } from '../../air-hold.js';
import type { Physics } from '../../physics.js';
import {
  type Port,
  type RateLevel,
  type Region,
  rateOf,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
} from '../solver.js';
import { BODY_FORCES_FIELD, FORCE_WORDS, rateLevelOf } from './rigid.js';

/** The layout version of the `forces` port region. */
const AIR_LAYOUT = 1;

/** What an {@link AirSolver} is made from. */
export interface AirSolverParams {
  /** The Physics the air loads were made on, the one a `RigidSolver` of the same world steps. */
  readonly physics: Physics;
  /** Body rows its `bodyForces` port covers (default the rigid kernel's body capacity at `init`). A load past them throws. */
  readonly capacity?: number;
}

/** The air's loads on rigid bodies, for the rigid solver through `bodyForces`. `id` is `'air'` unless a world holds more. */
export class AirSolver implements Solver<AirSolverParams> {
  private hold: AirHold | null = null;
  private host: SolverHost | null = null;
  private level: RateLevel = 0;
  private step0 = 0;
  private forces: Region | null = null;
  private capacity = 0;

  constructor(readonly id = 'air') {}

  describe(): SolverDescription {
    const level = this.hold ? this.level : 0;
    return {
      id: this.id,
      fields: [{ field: BODY_FORCES_FIELD, access: 'accumulate' }],
      rate: level,
      // Asked after init, which sets the level (describe comes first, before the Physics is known).
      stableRate: () => (this.hold ? this.level : 0),
    };
  }

  init(host: SolverHost, params: AirSolverParams): void {
    const physics = params?.physics;
    if (!physics || typeof physics.attach !== 'function' || !physics.kernel)
      throw new TypeError('An AirSolver steps the air loads of a Physics: world.add(new AirSolver(), {physics}).');
    this.level = rateLevelOf(physics.fixedTimestep);
    this.step0 = physics.fixedTimestep;
    const capacity = params.capacity ?? physics.kernel.capacity;
    if (!(Number.isInteger(capacity) && capacity > 0))
      throw new RangeError(`An AirSolver's capacity is a whole number of body rows above 0; got ${capacity}.`);
    this.capacity = capacity;
    this.forces = host.allocate('forces', capacity * FORCE_WORDS * 8, 'f64', AIR_LAYOUT);
    this.host = host;
    const hold = airHoldOf(physics);
    hold.driven = true;
    this.hold = hold;
  }

  private live(): AirHold {
    if (!this.hold)
      throw new MargoError('state', 'AirSolver is not in a world yet; add it with world.add(solver, {physics}).');
    return this.hold;
  }

  step(context: StepContext, dt: number): void {
    const hold = this.live();
    if (dt !== this.step0)
      throw new MargoError(
        'state',
        `AirSolver steps ${this.step0} s, and the world asked for ${dt} s; keep the Physics's fixedTimestep as it was added.`,
      );
    // A view taken afresh: another solver's allocation may have grown the world's memory.
    const forces = new Float64Array(this.host!.memory.buffer, this.forces!.byteOffset, this.capacity * FORCE_WORDS);
    forces.fill(0);
    hold.stepInto(forces, dt, context.tick / rateOf(context.level));
  }

  /** The loads of this tick, held over the rigid solver's next step. */
  exportPorts(tick: number): readonly Port[] {
    this.live();
    return [{ field: BODY_FORCES_FIELD.name, region: this.forces!, tick, cell: [0, 0, 0] }];
  }

  importPorts(_tick: number): void {}

  stateRegions(): readonly Region[] {
    return [];
  }

  extraState(): readonly Region[] {
    return [];
  }
}
