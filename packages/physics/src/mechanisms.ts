// Mechanical constraints between two bodies' motions: a gear, a rack and pinion and a pulley. Each is a row of the kernel's solve
// (kernel/src/couplings.rs), solved in every substep next to the joints and contacts with sequential impulses and a warm start, so
// it holds exactly through a step, shares the work with the bodies' other constraints and wakes and sleeps with them. A row is rigid
// by default or soft, as the constraint of Catto, "Soft Constraints", GDC 2011 (a frequency and a damping ratio). Baraff,
// "Linear-Time Dynamics using Lagrange Multipliers", SIGGRAPH 1996, is the form of a constraint between two bodies' coordinates as
// one row of the system. They act next to the joints that guide the bodies (a hinge for each gear, a slider for a rack).
import { checkVec, type Vec3 } from './math.js';
import type { PhysicsBody } from './body.js';
import type { Physics, PhysicsAttachment } from './physics.js';

type V = [number, number, number];
const unit = (a: Vec3, label: string): V => {
  checkVec(a, label);
  const n = Math.hypot(a[0], a[1], a[2]);
  if (!(n > 0)) throw new RangeError(`${label} must not be zero; pass a vector with a length.`);
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** Options of a mechanism's constraint. */
export interface MechanismOptions {
  /** The constraint's stiffness as a natural frequency in hertz (default 0: rigid, its error corrected by `correction`). */
  frequency?: number;
  /** Damping ratio of a soft constraint (default 1). */
  damping?: number;
  /** The share of the position error a rigid constraint removes each substep's biased pass (default 0.2). */
  correction?: number;
}

const GEAR = 1;
const RACK_AND_PINION = 2;
const PULLEY = 3;
const DISTANCE = 4;

abstract class Mechanism implements PhysicsAttachment {
  protected readonly slot: number;
  private released = false;

  protected constructor(
    protected readonly physics: Physics,
    kind: 1 | 2 | 3 | 4,
    protected readonly a: PhysicsBody,
    protected readonly b: PhysicsBody,
    options: MechanismOptions,
  ) {
    const { frequency = 0, damping = 1, correction = 0.2 } = options;
    if (!(frequency >= 0 && Number.isFinite(frequency)))
      throw new RangeError('Frequency is 0 (rigid) or a number of hertz; pass options.frequency of 0 or above.');
    if (!(damping >= 0 && Number.isFinite(damping)))
      throw new RangeError('Damping ratio is 0 or more; pass options.damping of 0 or above.');
    if (!(correction >= 0 && correction <= 1))
      throw new RangeError('Correction is a share from 0 to 1; pass options.correction between them.');
    const slot = physics.kernel.addCoupling(kind, a.row, b.row);
    if (slot < 0)
      throw new RangeError(
        'A mechanism joins two different live bodies, and a world holds 64; pass two bodies, or remove one first.',
      );
    this.slot = slot;
    physics.kernel.setCoupling(slot, 8, [frequency, damping, correction]);
    physics.attach(this);
  }

  /** The error the mechanism has built up (the gear's angle sum, the rack's offset, the rope's stretch) and the impulse it last gave. */
  state(): { error: number; impulse: number } {
    return this.physics.kernel.couplingState(this.slot);
  }

  /** @internal */
  bodyRemoved(body: PhysicsBody): void {
    if (body === this.a || body === this.b) this.remove();
  }

  /** Lets go of the constraint. */
  remove(): void {
    if (this.released) return;
    this.released = true;
    this.physics.kernel.removeCoupling(this.slot);
    this.physics.detach(this);
  }

  /** @internal */
  dispose(): void {
    if (!this.released) this.physics.kernel.removeCoupling(this.slot);
    this.released = true;
  }
}

/** Options of {@link GearJoint}. */
export interface GearOptions extends MechanismOptions {
  /** Turn axis of the first gear in its own frame (default z). */
  axisA?: Vec3;
  /** Turn axis of the second gear in its own frame (default z). */
  axisB?: Vec3;
  /** Teeth ratio (default 1): the first gear's angle plus `ratio` times the second's stays constant, so with a positive ratio the gears turn opposite ways about their axes. */
  ratio?: number;
}

/**
 * A gear: the angle of the first body about its axis plus `ratio` times the angle of the second about its own stays what it was
 * when the gear was made (Box2D's and Jolt's gear joint, for two hinged bodies). Hinge each body to the world or a frame, then join
 * them.
 */
export class GearJoint extends Mechanism {
  constructor(physics: Physics, bodyA: PhysicsBody, bodyB: PhysicsBody, options: GearOptions = {}) {
    const axisA = unit(options.axisA ?? [0, 0, 1], 'Axis A'),
      axisB = unit(options.axisB ?? [0, 0, 1], 'Axis B'),
      ratio = options.ratio ?? 1;
    if (!Number.isFinite(ratio) || ratio === 0)
      throw new RangeError('A gear ratio is a nonzero number; pass options.ratio other than 0.');
    super(physics, GEAR, bodyA, bodyB, options);
    physics.kernel.setCoupling(this.slot, 0, axisA);
    physics.kernel.setCoupling(this.slot, 1, axisB);
    physics.kernel.setCoupling(this.slot, 6, [ratio, 0, 0]);
  }
}

/** Options of {@link RackAndPinionJoint}. */
export interface RackAndPinionOptions extends MechanismOptions {
  /** Turn axis of the pinion in its frame (default z). */
  pinionAxis?: Vec3;
  /** Direction the rack slides, in its frame (default x). */
  rackAxis?: Vec3;
  /** Pitch radius of the pinion in metres (default 1): the rack moves this far a radian. */
  radius?: number;
}

/**
 * A rack and pinion: the rack slides `radius` metres for each radian the pinion turns (with the pinion's angle times the radius
 * plus the rack's position along its axis staying what it was when the joint was made). Hinge the pinion and slide the rack on
 * their own joints, then join them.
 */
export class RackAndPinionJoint extends Mechanism {
  constructor(physics: Physics, pinion: PhysicsBody, rack: PhysicsBody, options: RackAndPinionOptions = {}) {
    const pinionAxis = unit(options.pinionAxis ?? [0, 0, 1], 'Pinion axis'),
      rackAxis = unit(options.rackAxis ?? [1, 0, 0], 'Rack axis'),
      radius = options.radius ?? 1;
    if (!(radius > 0 && Number.isFinite(radius)))
      throw new RangeError('Pinion radius is a positive number of metres; pass options.radius above 0.');
    super(physics, RACK_AND_PINION, pinion, rack, options);
    physics.kernel.setCoupling(this.slot, 0, pinionAxis);
    physics.kernel.setCoupling(this.slot, 1, rackAxis);
    physics.kernel.setCoupling(this.slot, 6, [radius, 0, 0]);
  }
}

/** Options of {@link PulleyJoint}. */
export interface PulleyOptions extends MechanismOptions {
  /** World point the rope runs over on the first side. */
  groundA: Vec3;
  /** World point the rope runs over on the second side. */
  groundB: Vec3;
  /** Where the rope is tied to the first body, in its frame (default its centre). */
  anchorA?: Vec3;
  /** Where the rope is tied to the second body, in its frame (default its centre). */
  anchorB?: Vec3;
  /** The second length counts this many times (default 1): the block and tackle of a lifting pulley. */
  ratio?: number;
}

/**
 * A pulley: the rope length on the first side plus `ratio` times the length on the second stays what it was when the joint was made,
 * so one body rises as the other falls (Box2D's and Jolt's pulley). The rope may go slack where gravity does not pull it taut: it
 * only pulls, never pushes.
 */
export class PulleyJoint extends Mechanism {
  constructor(physics: Physics, bodyA: PhysicsBody, bodyB: PhysicsBody, options: PulleyOptions) {
    checkVec(options.groundA, 'Ground A');
    checkVec(options.groundB, 'Ground B');
    const anchorA: V = options.anchorA ? ([...options.anchorA] as V) : [0, 0, 0],
      anchorB: V = options.anchorB ? ([...options.anchorB] as V) : [0, 0, 0],
      ratio = options.ratio ?? 1;
    checkVec(anchorA, 'Anchor A');
    checkVec(anchorB, 'Anchor B');
    if (!(ratio > 0 && Number.isFinite(ratio)))
      throw new RangeError('A pulley ratio is a positive number; pass options.ratio above 0.');
    super(physics, PULLEY, bodyA, bodyB, options);
    const k = physics.kernel;
    k.setCoupling(this.slot, 2, anchorA);
    k.setCoupling(this.slot, 3, anchorB);
    k.setCoupling(this.slot, 4, options.groundA as V);
    k.setCoupling(this.slot, 5, options.groundB as V);
    k.setCoupling(this.slot, 6, [ratio, 0, 0]);
    // The rope as long as it is now.
    const length = (body: PhysicsBody, anchor: V, ground: Vec3): number => {
      const [px, py, pz] = body.position,
        q = body.rotation,
        [x, y, z] = anchor,
        t = [2 * (q[1] * z - q[2] * y), 2 * (q[2] * x - q[0] * z), 2 * (q[0] * y - q[1] * x)],
        turned = [
          x + q[3] * t[0]! + (q[1] * t[2]! - q[2] * t[1]!),
          y + q[3] * t[1]! + (q[2] * t[0]! - q[0] * t[2]!),
          z + q[3] * t[2]! + (q[0] * t[1]! - q[1] * t[0]!),
        ];
      return Math.hypot(px + turned[0]! - ground[0], py + turned[1]! - ground[1], pz + turned[2]! - ground[2]);
    };
    k.setCoupling(this.slot, 7, [
      length(bodyA, anchorA, options.groundA) + ratio * length(bodyB, anchorB, options.groundB),
      0,
      0,
    ]);
  }
}

/** Options of {@link DistanceJoint}. */
export interface DistanceOptions extends MechanismOptions {
  /** Where the first body is held, in its frame (default its centre). */
  anchorA?: Vec3;
  /** Where the second body is held, in its frame (default its centre). */
  anchorB?: Vec3;
  /** The least distance in metres (default 0: they may touch). */
  min?: number;
  /** The greatest distance in metres (default no greatest). */
  max?: number;
}

/**
 * A distance joint with a range: the two anchors stay between `min` and `max` apart and are free in between (a rope is a joint
 * with only a `max`, a strut one with only a `min`). Rigid by default; give `frequency` and `damping` for a spring-like end, one
 * that gives a little and pulls back. For a spring about a rest length use a `spring` joint.
 */
export class DistanceJoint extends Mechanism {
  constructor(physics: Physics, bodyA: PhysicsBody, bodyB: PhysicsBody, options: DistanceOptions = {}) {
    const anchorA: V = options.anchorA ? ([...options.anchorA] as V) : [0, 0, 0],
      anchorB: V = options.anchorB ? ([...options.anchorB] as V) : [0, 0, 0],
      { min = 0, max = 0 } = options;
    checkVec(anchorA, 'Anchor A');
    checkVec(anchorB, 'Anchor B');
    if (!(min >= 0 && Number.isFinite(min)))
      throw new RangeError('Distance min is 0 or more metres; pass options.min of 0 or above.');
    if (!(max >= 0 && Number.isFinite(max)) || (max > 0 && max < min))
      throw new RangeError('Distance max is 0 (none) or at least min, in metres; pass options.max above options.min.');
    super(physics, DISTANCE, bodyA, bodyB, options);
    const k = physics.kernel;
    k.setCoupling(this.slot, 2, anchorA);
    k.setCoupling(this.slot, 3, anchorB);
    k.setCoupling(this.slot, 6, [min, 0, 0]);
    k.setCoupling(this.slot, 7, [max, 0, 0]);
  }
}
