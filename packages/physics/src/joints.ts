import { MargoError } from '@margoengine/math/errors';
import type { ImpulseJoint, JointData, SphericalImpulseJoint, UnitImpulseJoint } from './rapier-types.js';
import type { RapierModule } from './shapes.js';
import type { PhysicsBody } from './body.js';
import { checkVec, quat, vec, type Quat, type Vec3 } from './math.js';

/** Drives a joint axis toward a target velocity or, as a spring, a target position. */
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
  /** The most force (prismatic) or torque (revolute, spherical) the motor applies, in N or N m. Default no cap. */
  maxForce?: number;
}

/** A spring toward a rotation, for {@link PhysicsJoint.setRotationMotor}: no targets, the rotation is the target. */
export type RotationMotorOptions = Pick<MotorOptions, 'stiffness' | 'damping' | 'model' | 'maxForce'> & {
  targetVelocity?: Vec3;
};

const maxForce = (motor: { maxForce?: number }): number => {
  const cap = motor.maxForce ?? Infinity;
  if (!(cap >= 0)) throw new RangeError('Motor maxForce must be 0 or more; pass newtons or newton metres.');
  return cap;
};

interface JointBase {
  /** Anchor in body A's local frame (default origin). */
  anchorA?: Vec3;
  /** Anchor in body B's local frame (default origin). */
  anchorB?: Vec3;
  /** Let the two bodies collide with each other (default false, as in Rapier). */
  contactsEnabled?: boolean;
}
/** Options for adding a joint between two bodies. */
export type JointOptions =
  | (JointBase & { type: 'fixed'; frameA?: Quat; frameB?: Quat })
  | (JointBase & { type: 'spherical' })
  /** Keeps the anchors at most `length` apart and lets them come closer (a slack rope or chain link). */
  | (JointBase & { type: 'rope'; length: number })
  /** Pulls the anchors toward `restLength` apart like a damped spring (`stiffness` N/m, `damping` N*s/m). */
  | (JointBase & { type: 'spring'; restLength: number; stiffness: number; damping?: number })
  | (JointBase & {
      type: 'revolute' | 'prismatic';
      axis: Vec3;
      limits?: readonly [number, number];
      motor?: MotorOptions;
    });

/** Kind of joint, the `type` of {@link JointOptions}. */
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
    if (!this.valid) throw new MargoError('state', 'Joint was removed; create a new one with physics.addJoint.');
    if (this.type !== 'revolute' && this.type !== 'prismatic')
      throw new TypeError('Limits and motors need a revolute or prismatic joint');
    return this.raw as UnitImpulseJoint;
  }
  private motors?: SphericalImpulseJoint;
  private spherical(): SphericalImpulseJoint {
    if (!this.valid) throw new MargoError('state', 'Joint was removed; create a new one with physics.addJoint.');
    if (this.type !== 'spherical') throw new TypeError('Rotation motors need a spherical joint; use setMotor on a hinge.');
    if (this.motors) return this.motors;
    const R = this.owner.rapier;
    if (!R.SphericalImpulseJoint || !R.JointAxis)
      throw new MargoError(
        'unsupported',
        'Spherical joint motors need Rapier 0.20 or later; upgrade @dimforge/rapier3d-compat.',
      );
    // Rapier hands a spherical joint back as a generic one, whose class has no motors: view the same joint as what it is.
    const raw = this.raw as ImpulseJoint & { rawSet: never; bodySet: never };
    return (this.motors = new R.SphericalImpulseJoint(raw.rawSet, raw.bodySet, raw.handle));
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
    raw.setMotorMaxForce(maxForce(motor));
    const velocity = motor.targetVelocity ?? 0;
    if (motor.targetPosition !== undefined)
      raw.configureMotor(motor.targetPosition, velocity, motor.stiffness ?? 1, motor.damping ?? 0);
    else raw.configureMotorVelocity(velocity, motor.damping ?? 1);
    this.wake();
    return this;
  }
  /**
   * Spherical joints: a spring that turns body B toward `rotation`, a unit quaternion [x, y, z, w] of body B in body A's
   * frame, conj(A) * B. It runs in the solver, so a high `stiffness` stays stable and `maxForce` caps the torque. The
   * With `model: 'force'`, a body of inertia I about the joint moves like a spring of frequency w and damping ratio z
   * for `stiffness` I w² and `damping` 2 z I w. `targetVelocity` is the relative spin the target itself has, rad/s in the
   * target's frame, so a moving target is tracked without lag.
   * @throws TypeError on any other joint type, RangeError for a rotation that is not a unit quaternion.
   * @throws MargoError with code `unsupported` on a Rapier without spherical motors (before 0.20).
   */
  setRotationMotor(rotation: Quat, motor: RotationMotorOptions = {}): this {
    const raw = this.spherical(),
      [x, y, z, w] = rotation;
    if (!(Math.abs(Math.hypot(x, y, z, w) - 1) < 1e-3))
      throw new RangeError('Rotation motors need a unit quaternion [x, y, z, w]; normalize the rotation.');
    const R = this.owner.rapier,
      axes = R.JointAxis!,
      model = motor.model === 'force' ? R.MotorModel.ForceBased : R.MotorModel.AccelerationBased,
      cap = maxForce(motor),
      stiffness = motor.stiffness ?? 1,
      damping = motor.damping ?? 0;
    // The solver measures a joint by the vector part of its rotation, which stops telling rotations apart near half a
    // turn. Moving the joint's frame on body A onto the target keeps what it measures small, and the motors' target 0.
    raw.setLocalFrame1(raw.anchor1(), quat(rotation));
    const spin = motor.targetVelocity;
    [axes.AngX, axes.AngY, axes.AngZ].forEach((axis, k) => {
      raw.configureMotorModel(axis, model);
      raw.setMotorMaxForce(axis, cap);
      raw.configureMotor(axis, 0, spin?.[k] ?? 0, stiffness, damping);
    });
    this.wake();
    return this;
  }
  /** Turns the motor off. */
  clearMotor(): this {
    if (this.type === 'spherical') {
      const raw = this.spherical(),
        axes = this.owner.rapier.JointAxis!;
      for (const axis of [axes.AngX, axes.AngY, axes.AngZ]) {
        raw.configureMotor(axis, 0, 0, 0, 0);
        raw.setMotorMaxForce(axis, 0);
      }
      this.wake();
      return this;
    }
    const raw = this.unit();
    // Gains of 0 leave a motor that still holds its target speed of 0: only a cap of 0 frees the joint.
    raw.configureMotor(0, 0, 0, 0);
    raw.setMotorMaxForce(0);
    this.wake();
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
    case 'rope': {
      if (!(options.length > 0) || !Number.isFinite(options.length))
        throw new RangeError('Rope joint length must be a positive finite number; pass the longest anchor distance.');
      if (!R.JointData.rope)
        throw new MargoError(
          'unsupported',
          'Rope joints need Rapier 0.12 or later; upgrade @dimforge/rapier3d-compat.',
        );
      return R.JointData.rope(options.length, vec(anchorA), vec(anchorB));
    }
    case 'spring': {
      const { restLength, stiffness, damping = 0 } = options;
      if (!(restLength >= 0) || !Number.isFinite(restLength))
        throw new RangeError('Spring restLength must be a finite number of at least 0; pass the relaxed distance.');
      if (!(stiffness >= 0) || !Number.isFinite(stiffness) || !(damping >= 0) || !Number.isFinite(damping))
        throw new RangeError('Spring stiffness and damping must be finite numbers of at least 0; pass N/m and N*s/m.');
      if (!R.JointData.spring)
        throw new MargoError(
          'unsupported',
          'Spring joints need Rapier 0.12 or later; upgrade @dimforge/rapier3d-compat.',
        );
      return R.JointData.spring(restLength, stiffness, damping, vec(anchorA), vec(anchorB));
    }
    default:
      throw new TypeError(
        `Unknown joint type ${(options as { type: string }).type}; use fixed, spherical, revolute, prismatic, rope or spring.`,
      );
  }
}
