import type { Kernel } from './kernel.js';
import { MargoError } from '@margoengine/math/errors';
import type { Body2D } from './body.js';
import type { Vec2D } from './shapes.js';

/** Motor of a revolute or prismatic joint. Give a target velocity, a target position, or both. */
export interface MotorOptions2D {
  /** Radians per second (revolute) or world units per second (prismatic). */
  targetVelocity?: number;
  /** How hard it chases the velocity. Default 1. */
  factor?: number;
  /** Radians (revolute) or world units (prismatic). */
  targetPosition?: number;
  stiffness?: number;
  damping?: number;
  maxForce?: number;
}

/** Options for a joint between two bodies. Anchors are in each body's local space, world units. */
export type JointOptions2D = {
  anchorA?: Vec2D;
  anchorB?: Vec2D;
  /** Let the two bodies collide with each other (default false). */
  collide?: boolean;
  /**
   * Accepted for code written for Rapier's multibody joints and ignored: every chain of joints solves exactly (block
   * elimination along the chain), so a long chain under a heavy end does not stretch. For joint-space control and inverse
   * kinematics use `Physics2D.addArticulation`.
   */
  multibody?: boolean;
} & (
  | { type: 'revolute'; limits?: readonly [number, number]; motor?: MotorOptions2D }
  | { type: 'prismatic'; axis: Vec2D; limits?: readonly [number, number]; motor?: MotorOptions2D }
  | { type: 'fixed'; angleA?: number; angleB?: number }
  | {
      /**
       * Any mix of the three locks of a plane joint: `lockX` and `lockY` hold the anchors' offset along the first and the
       * second axis of body A's frame (both together pin a point, one alone is a pin-slot that slides along the other
       * axis), `lockAngle` holds the turn between the frames. `frameA` and `frameB` (radians, default 0) turn the frames;
       * the joint holds B's frame turned by `frameB` against A's turned by `frameA`.
       */
      type: 'generic';
      lockX?: boolean;
      lockY?: boolean;
      lockAngle?: boolean;
      frameA?: number;
      frameB?: number;
    }
  | {
      /** A pin-slot: the anchors slide along `axis` (in body A's frame) and the bodies turn freely. */
      type: 'slot';
      axis: Vec2D;
    }
  | { type: 'rope'; length: number }
  | { type: 'spring'; restLength: number; stiffness: number; damping?: number }
);

const finite = (value: number, what: string): number => {
  if (!Number.isFinite(value)) throw new RangeError(`${what} must be a finite number, got ${value}; fix the value.`);
  return value;
};

/** @internal Writes a joint's buffer words (kernel/src/api.rs, `joint_create`) and returns the unit of its limits. */
export function writeJoint(kernel: Kernel, o: JointOptions2D, k: number): number {
  const io = kernel.io(32);
  io.u.fill(0, 0, 32);
  const a = o.anchorA ?? [0, 0],
    b = o.anchorB ?? [0, 0];
  io.f.set([finite(a[0], 'anchorA x') * k, finite(a[1], 'anchorA y') * k, finite(b[0], 'anchorB x') * k, finite(b[1], 'anchorB y') * k], 1);
  const limits = (o as { limits?: readonly [number, number] }).limits;
  const unit = o.type === 'prismatic' ? k : 1;
  if (limits) {
    io.u[5] = 1;
    io.f[6] = finite(limits[0], 'joint limit') * unit;
    io.f[7] = finite(limits[1], 'joint limit') * unit;
  }
  const motor = (o as { motor?: MotorOptions2D }).motor;
  if (motor) writeMotor(io.f, io.u, 8, motor, unit);
  switch (o.type) {
    case 'revolute':
      io.u[0] = 0;
      break;
    case 'prismatic':
      io.u[0] = 1;
      io.f[14] = finite(o.axis[0], 'axis x');
      io.f[15] = finite(o.axis[1], 'axis y');
      break;
    case 'fixed': {
      io.u[0] = 2;
      const [pa, pb] = [o.angleA ?? 0, o.angleB ?? 0];
      io.f.set([Math.cos(pa), Math.sin(pa), Math.cos(pb), Math.sin(pb)], 16);
      break;
    }
    case 'generic': {
      io.u[0] = 5;
      io.u[24] = (o.lockX ? 1 : 0) | (o.lockY ? 2 : 0) | (o.lockAngle ? 4 : 0);
      const [pa, pb] = [finite(o.frameA ?? 0, 'frameA'), finite(o.frameB ?? 0, 'frameB')];
      io.f.set([Math.cos(pa), Math.sin(pa), Math.cos(pb), Math.sin(pb)], 16);
      break;
    }
    case 'slot': {
      io.u[0] = 5;
      // Lock the offset across the slot: the second axis of a frame whose first axis is the slot's.
      io.u[24] = 2;
      const angle = Math.atan2(finite(o.axis[1], 'axis y'), finite(o.axis[0], 'axis x'));
      io.f.set([Math.cos(angle), Math.sin(angle), 1, 0], 16);
      break;
    }
    case 'rope':
      io.u[0] = 3;
      io.f[20] = finite(o.length, 'rope length') * k;
      break;
    case 'spring':
      io.u[0] = 4;
      io.f[20] = finite(o.restLength, 'spring restLength') * k;
      io.f[21] = finite(o.stiffness, 'spring stiffness');
      io.f[22] = finite(o.damping ?? 0, 'spring damping');
      break;
    default:
      throw new TypeError(
        `Unknown joint type "${(o as { type?: string }).type}"; use revolute, prismatic, fixed, generic, slot, rope or spring.`,
      );
  }
  return unit;
}

/** The kernel's motor from the options: a velocity motor chases `targetVelocity` with gain `factor`, a position motor is a spring. */
function writeMotor(f: Float32Array, u: Uint32Array, at: number, m: MotorOptions2D, unit: number): void {
  u[at] = 1;
  const velocity = m.targetVelocity !== undefined,
    position = m.targetPosition !== undefined;
  f[at + 1] = position ? finite(m.targetPosition as number, 'motor targetPosition') * unit : 0;
  f[at + 2] = velocity ? finite(m.targetVelocity as number, 'motor targetVelocity') * unit : 0;
  f[at + 3] = position ? finite(m.stiffness ?? 1, 'motor stiffness') : 0;
  f[at + 4] = position ? finite(m.damping ?? 0, 'motor damping') : finite(m.factor ?? 1, 'motor factor');
  if (position && velocity && m.damping === undefined) f[at + 4] = finite(m.factor ?? 1, 'motor factor');
  f[at + 5] = m.maxForce === undefined ? Infinity : finite(m.maxForce, 'motor maxForce');
}

/** A joint between two bodies. */
export class Joint2D {
  private removed = false;
  /** @internal */
  constructor(
    private readonly kernel: Kernel,
    private readonly world: number,
    /** The kernel's handle. @internal */
    readonly handle: number,
    readonly bodyA: Body2D,
    readonly bodyB: Body2D,
    private readonly type: JointOptions2D['type'],
    private readonly unit: number,
    private readonly onRemove: (joint: Joint2D) => void,
  ) {}
  private get limited(): boolean {
    if (this.type !== 'revolute' && this.type !== 'prismatic')
      throw new TypeError('Only revolute and prismatic joints have limits and motors; use one of those types.');
    if (this.removed) throw new MargoError('state', 'Joint2D was removed; add a new joint with Physics2D.addJoint.');
    return true;
  }
  /** Revolute: radians. Prismatic: world units. */
  setLimits(min: number, max: number): this {
    void this.limited;
    const u = this.unit;
    this.kernel.ok(this.kernel.exports.joint_set_limits(this.world, this.handle, 1, finite(min, 'limit') * u, finite(max, 'limit') * u));
    return this;
  }
  /** Removes the limits. */
  clearLimits(): this {
    void this.limited;
    this.kernel.ok(this.kernel.exports.joint_set_limits(this.world, this.handle, 0, 0, 0));
    return this;
  }
  setMotor(motor: MotorOptions2D): this {
    void this.limited;
    const io = this.kernel.io(8);
    writeMotor(io.f, io.u, 0, motor, this.unit);
    // `writeMotor` puts its flag first; the kernel reads the five numbers from word 0.
    io.f.copyWithin(0, 1, 6);
    this.kernel.ok(this.kernel.exports.joint_set_motor(this.world, this.handle, 1));
    return this;
  }
  /** Turns the motor off. */
  clearMotor(): this {
    void this.limited;
    this.kernel.ok(this.kernel.exports.joint_set_motor(this.world, this.handle, 0));
    return this;
  }
  remove(): void {
    this.onRemove(this);
  }
  /** @internal */
  free(): void {
    if (this.removed) return;
    this.removed = true;
    this.kernel.exports.joint_remove(this.world, this.handle);
  }
}
