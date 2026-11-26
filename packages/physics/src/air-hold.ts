// The air's loads on a Physics's rigid bodies (WindForce, WingForce, RotorForce, LiftingGas): each step every load computes
// its force and torque, and one hold per Physics sums them by body and holds the sum for that step only. Stepped alone, the
// sum goes into the bodies' f32 force and torque columns before the kernel's step, and exactly what the columns took comes off
// after it (the difference of two f32 values is exact), so a body keeps its own forces to the bit. In a world, an `AirSolver`
// steps the loads instead and the same sums go into the `bodyForces` port, which the `RigidSolver` adds and takes off the
// same way: a world and Physics stepped alone are the same bits.
import type { PhysicsBody } from './body.js';
import type { Vec3 } from './math.js';
import type { Physics, PhysicsAttachment } from './physics.js';

/** An air load the hold steps: it computes its load for a step of `dt` and hands it to {@link AirHold.hold}. */
export interface AirLoad {
  /** @internal Computes this step's load and holds it. */
  load(dt: number): void;
}

/** Words of a body's entry: what its columns were before (6), the summed load (6) and what the columns took (6). */
const ENTRY = 18;
const holds = new WeakMap<Physics, AirHold>();

/** The hold of `physics`'s air loads, made and attached the first time it is asked for. */
export function airHoldOf(physics: Physics): AirHold {
  let hold = holds.get(physics);
  if (!hold) holds.set(physics, (hold = new AirHold(physics)));
  return hold;
}

/** @internal Sums the air's loads by body and holds them for one step. */
export class AirHold implements PhysicsAttachment {
  /** The loads, in the order they were made: the order their forces are summed in. */
  readonly loads = new Set<AirLoad>();
  /** The `bodyForces` words of the stepping world (`FORCE_WORDS` a body row) while an `AirSolver` steps the loads. */
  private port: Float64Array | null = null;
  /** Set once an `AirSolver` drives the loads: the Physics's own step then leaves them alone. */
  driven = false;
  private readonly entries = new Map<PhysicsBody, Float64Array>();
  /** The world's time while an `AirSolver` steps the loads, s. */
  private time: number | null = null;

  constructor(private readonly physics: Physics) {
    physics.attach(this);
  }

  /** @internal Holds `force` (N) and `torque` (N m, about the centre of mass) on `body` for this step. */
  hold(body: PhysicsBody, force: Vec3, torque: Vec3): void {
    if (body.type !== 'dynamic' || !body.valid) return;
    if (force[0] === 0 && force[1] === 0 && force[2] === 0 && torque[0] === 0 && torque[1] === 0 && torque[2] === 0)
      return;
    const port = this.port;
    if (port) {
      const at = body.row * 6;
      if (at + 6 > port.length)
        throw new RangeError(
          `An air load is on body row ${body.row}, past the AirSolver's ${port.length / 6} rows; make it with a capacity of ${body.row + 1} or more.`,
        );
      for (let k = 0; k < 3; k++) {
        port[at + k]! += force[k]!;
        port[at + 3 + k]! += torque[k]!;
      }
      return;
    }
    const kernel = this.physics.kernel,
      c = kernel.columns,
      row = body.row,
      columns = [c.forceX, c.forceY, c.forceZ, c.torqueX, c.torqueY, c.torqueZ];
    let entry = this.entries.get(body);
    if (!entry) {
      entry = new Float64Array(ENTRY);
      for (let k = 0; k < 6; k++) entry[k] = columns[k]![row]!;
      this.entries.set(body, entry);
    }
    for (let k = 0; k < 3; k++) {
      entry[6 + k]! += force[k]!;
      entry[9 + k]! += torque[k]!;
    }
    kernel.wake(row);
    // The column holds its own force plus the sum, rounded once, as a world's RigidSolver adds the summed port.
    for (let k = 0; k < 6; k++) {
      const column = columns[k]!;
      column[row] = entry[k]! + entry[6 + k]!;
      entry[12 + k] = column[row]! - entry[k]!;
    }
  }

  /**
   * @internal The time the loads sample the air at, s: the world's tick while an `AirSolver` steps them (a world's restore
   * rewinds its ticks, not the Physics's step count), else the Physics's steps times its fixed step.
   */
  now(): number {
    return this.time ?? this.physics.stepCount * this.physics.fixedTimestep;
  }

  /** @internal Steps the loads into a world's `bodyForces` words at the world's time `time`. */
  stepInto(port: Float64Array, dt: number, time: number): void {
    this.port = port;
    this.time = time;
    try {
      for (const load of this.loads) load.load(dt);
    } finally {
      this.port = null;
      this.time = null;
    }
  }

  /** @internal Takes off what each body's columns took for the step. */
  afterStep(): void {
    if (this.entries.size === 0) return;
    const c = this.physics.kernel.columns,
      columns = [c.forceX, c.forceY, c.forceZ, c.torqueX, c.torqueY, c.torqueZ];
    for (const [body, entry] of this.entries) {
      if (!body.valid) continue;
      for (let k = 0; k < 6; k++) columns[k]![body.row] -= entry[12 + k]!;
    }
    this.entries.clear();
  }

  /** @internal */
  bodyRemoved(body: PhysicsBody): void {
    this.entries.delete(body);
  }

  /** @internal */
  dispose(): void {
    this.entries.clear();
    this.loads.clear();
    holds.delete(this.physics);
  }
}
