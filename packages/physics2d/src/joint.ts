import type { RapierModule2D, ImpulseJoint2D, JointData2D, UnitImpulseJoint2D, World2D } from './rapier-types.js';
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
} & (
  | { type: 'revolute'; limits?: readonly [number, number]; motor?: MotorOptions2D }
  | { type: 'prismatic'; axis: Vec2D; limits?: readonly [number, number]; motor?: MotorOptions2D }
  | { type: 'fixed'; angleA?: number; angleB?: number }
  | { type: 'rope'; length: number }
  | { type: 'spring'; restLength: number; stiffness: number; damping?: number }
);

/** @internal */
export function createJointData(R: RapierModule2D, o: JointOptions2D, k: number): JointData2D {
  const a = o.anchorA ?? [0, 0],
    b = o.anchorB ?? [0, 0],
    pa = { x: a[0] * k, y: a[1] * k },
    pb = { x: b[0] * k, y: b[1] * k },
    J = R.JointData;
  switch (o.type) {
    case 'revolute':
      return J.revolute(pa, pb);
    case 'prismatic':
      return J.prismatic(pa, pb, { x: o.axis[0], y: o.axis[1] });
    case 'fixed':
      return J.fixed(pa, o.angleA ?? 0, pb, o.angleB ?? 0);
    case 'rope':
      return J.rope(o.length * k, pa, pb);
    case 'spring':
      return J.spring(o.restLength * k, o.stiffness, o.damping ?? 0, pa, pb);
    default:
      throw new TypeError(
        `Unknown joint type "${(o as { type?: string }).type}"; use revolute, prismatic, fixed, rope or spring.`,
      );
  }
}

/** A Rapier impulse joint between two bodies. */
export class Joint2D {
  /** @internal */
  constructor(
    private readonly world: World2D,
    readonly raw: ImpulseJoint2D,
    readonly bodyA: Body2D,
    readonly bodyB: Body2D,
    private readonly unit: number,
    private readonly onRemove: (joint: Joint2D) => void,
  ) {}
  private get unitJoint(): UnitImpulseJoint2D {
    const joint = this.raw as UnitImpulseJoint2D;
    if (typeof joint.setLimits !== 'function')
      throw new TypeError('Only revolute and prismatic joints have limits and motors; use one of those types.');
    return joint;
  }
  /** Revolute: radians. Prismatic: world units. */
  setLimits(min: number, max: number): this {
    this.unitJoint.setLimits(min * this.unit, max * this.unit);
    return this;
  }
  setMotor(motor: MotorOptions2D): this {
    const joint = this.unitJoint;
    if (motor.maxForce !== undefined) joint.setMotorMaxForce(motor.maxForce);
    if (motor.targetPosition !== undefined)
      joint.configureMotorPosition(motor.targetPosition * this.unit, motor.stiffness ?? 1, motor.damping ?? 0);
    if (motor.targetVelocity !== undefined)
      joint.configureMotorVelocity(motor.targetVelocity * this.unit, motor.factor ?? 1);
    return this;
  }
  remove(): void {
    this.onRemove(this);
  }
  /** @internal */
  free(wake = true): void {
    this.world.removeImpulseJoint(this.raw, wake);
  }
}
