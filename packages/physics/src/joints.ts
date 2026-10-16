import type { ImpulseJoint, JointData, UnitImpulseJoint } from './rapier-types.js';
import type { RapierModule } from './shapes.js';
import type { PhysicsBody } from './body.js';
import { checkVec, quat, vec, type Quat, type Vec3 } from './math.js';

export interface MotorOptions {
  /** Target velocity in radians (revolute) or units (prismatic) per second. */
  targetVelocity?: number;
  /** Target angle (revolute) or offset along the axis (prismatic). Turns the motor into a spring. */
  targetPosition?: number;
  /** Spring stiffness toward `targetPosition` (default 0 when only a velocity is given). */
  stiffness?: number;
  /** Damping toward `targetVelocity` (default 1 for velocity motors). */
  damping?: number;
  /** 'acceleration' (default, mass independent) or 'force'. */
  model?: 'acceleration' | 'force';
}

interface JointBase {
  /** Anchor in body A's local frame (default origin). */
  anchorA?: Vec3;
  /** Anchor in body B's local frame (default origin). */
  anchorB?: Vec3;
  /** Let the two bodies collide with each other (default false, as in Rapier). */
  contactsEnabled?: boolean;
}
export type JointOptions =
  | (JointBase & { type: 'fixed'; frameA?: Quat; frameB?: Quat })
  | (JointBase & { type: 'spherical' })
  | (JointBase & {
      type: 'revolute' | 'prismatic';
      axis: Vec3;
      limits?: readonly [number, number];
      motor?: MotorOptions;
    });

export type JointType = JointOptions['type'];

/** An impulse joint between two bodies. */
export class PhysicsJoint {
  private removed = false;
  /** @internal */
  constructor(
    private readonly owner: { readonly rapier: RapierModule; removeJoint(joint: PhysicsJoint): void },
    readonly raw: ImpulseJoint,
    readonly type: JointType,
    readonly bodyA: PhysicsBody,
    readonly bodyB: PhysicsBody,
  ) {}
  get valid(): boolean {
    return !this.removed && this.raw.isValid();
  }
  /** @internal */
  markRemoved(): void {
    this.removed = true;
  }
  private unit(): UnitImpulseJoint {
    if (!this.valid) throw new Error('Joint was removed');
    if (this.type !== 'revolute' && this.type !== 'prismatic')
      throw new TypeError('Limits and motors need a revolute or prismatic joint');
    return this.raw as UnitImpulseJoint;
  }
  /** Angle (revolute, radians) or translation (prismatic) limits. */
  setLimits(min: number, max: number): this {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max)
      throw new RangeError('Joint limits need finite min <= max');
    this.unit().setLimits(min, max);
    this.wake();
    return this;
  }
  get limits(): [number, number] | null {
    const raw = this.unit();
    return raw.limitsEnabled() ? [raw.limitsMin(), raw.limitsMax()] : null;
  }
  setMotor(motor: MotorOptions): this {
    const raw = this.unit(),
      R = this.owner.rapier;
    raw.configureMotorModel(motor.model === 'force' ? R.MotorModel.ForceBased : R.MotorModel.AccelerationBased);
    const velocity = motor.targetVelocity ?? 0;
    if (motor.targetPosition !== undefined)
      raw.configureMotor(motor.targetPosition, velocity, motor.stiffness ?? 1, motor.damping ?? 0);
    else raw.configureMotorVelocity(velocity, motor.damping ?? 1);
    this.wake();
    return this;
  }
  /** Turns the motor off. */
  clearMotor(): this {
    this.unit().configureMotor(0, 0, 0, 0);
    return this;
  }
  set contactsEnabled(value: boolean) {
    if (this.valid) this.raw.setContactsEnabled(value);
  }
  get contactsEnabled(): boolean {
    return this.valid && this.raw.contactsEnabled();
  }
  remove(): void {
    if (!this.removed) this.owner.removeJoint(this);
  }
  private wake(): void {
    if (this.bodyA.valid) this.bodyA.raw.wakeUp();
    if (this.bodyB.valid) this.bodyB.raw.wakeUp();
  }
}

export function createJointData(R: RapierModule, options: JointOptions): JointData {
  const anchorA = options.anchorA ?? [0, 0, 0],
    anchorB = options.anchorB ?? [0, 0, 0];
  checkVec(anchorA, 'anchorA');
  checkVec(anchorB, 'anchorB');
  switch (options.type) {
    case 'fixed':
      return R.JointData.fixed(vec(anchorA), quat(options.frameA), vec(anchorB), quat(options.frameB));
    case 'spherical':
      return R.JointData.spherical(vec(anchorA), vec(anchorB));
    case 'revolute':
    case 'prismatic': {
      checkVec(options.axis, 'Joint axis');
      const length = Math.hypot(...options.axis);
      if (!length) throw new RangeError('Joint axis must be nonzero');
      const axis = vec([options.axis[0] / length, options.axis[1] / length, options.axis[2] / length]);
      if (options.limits) {
        const [min, max] = options.limits;
        if (!Number.isFinite(min) || !Number.isFinite(max) || min > max)
          throw new RangeError('Joint limits need finite min <= max');
      }
      // Limits are applied after creation with setLimits: JointData.limits is not honored by every Rapier build.
      return options.type === 'revolute'
        ? R.JointData.revolute(vec(anchorA), vec(anchorB), axis)
        : R.JointData.prismatic(vec(anchorA), vec(anchorB), axis);
    }
    default:
      throw new TypeError(`Unknown joint type ${(options as { type: string }).type}`);
  }
}
