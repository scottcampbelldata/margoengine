// Named joints built from the generic joint (a D6 with a lock, a limit and a motor on each of its six axes): a universal joint and a
// wheel joint. They add nothing to the solver; they choose the locks, limits and motors a mechanism of that name has, so each is
// solved with the rows of any other joint, in every substep.
import type { PhysicsBody } from './body.js';
import type { PhysicsJoint } from './joints.js';
import { checkVec, type Quat, type Vec3 } from './math.js';
import type { Physics } from './physics.js';

/** Options of {@link addUniversalJoint}. */
export interface UniversalJointOptions {
  /** Anchor in the first body's frame (default its origin). */
  anchorA?: Vec3;
  /** Anchor in the second body's frame (default its origin). */
  anchorB?: Vec3;
  /** Frames on the two bodies: the joint turns about the X and Y axes of frame A (default the bodies' own axes). */
  frameA?: Quat;
  frameB?: Quat;
  /** Limits of the turn about the first axis (X of frame A) and about the second (Y), in radians. */
  limitsX?: readonly [number, number];
  limitsY?: readonly [number, number];
  /** Motors of the two turns: a velocity or a spring toward a target angle. */
  motorX?: Parameters<PhysicsJoint['setAxisMotor']>[1];
  motorY?: Parameters<PhysicsJoint['setAxisMotor']>[1];
}

/**
 * A universal joint (a cardan or Hooke joint): the bodies share a point and turn about two axes, X and Y of frame A, and cannot twist
 * about the third (Z), so a shaft joined to another at an angle turns it at the same speed on average. A generic joint with the three
 * sliding axes and the twist locked; `limitsX`, `limitsY`, `motorX` and `motorY` limit and drive the two turns. Returns the joint,
 * whose `setAxisLimits` and `setAxisMotor` change them later.
 */
export function addUniversalJoint(
  physics: Physics,
  bodyA: PhysicsBody,
  bodyB: PhysicsBody,
  options: UniversalJointOptions = {},
): PhysicsJoint {
  const { anchorA, anchorB, frameA, frameB, limitsX, limitsY, motorX, motorY } = options;
  if (anchorA) checkVec(anchorA, 'Anchor A');
  if (anchorB) checkVec(anchorB, 'Anchor B');
  return physics.addJoint(bodyA, bodyB, {
    type: 'generic',
    anchorA,
    anchorB,
    frameA,
    frameB,
    locked: ['linX', 'linY', 'linZ', 'angZ'],
    limits: { ...(limitsX ? { angX: limitsX } : {}), ...(limitsY ? { angY: limitsY } : {}) },
    motors: { ...(motorX ? { angX: motorX } : {}), ...(motorY ? { angY: motorY } : {}) },
  });
}

/** Options of {@link addWheelJoint}. */
export interface WheelJointOptions {
  /** Where the wheel's hub is on the chassis, in the chassis frame (default its origin). */
  anchor?: Vec3;
  /** The wheel's own anchor, in its frame (default its centre). */
  wheelAnchor?: Vec3;
  /** Suspension spring: natural frequency in hertz (default 4) and damping ratio (default 0.7), per kilogram of the wheel. */
  frequency?: number;
  damping?: number;
  /** How far the wheel may go from its rest place along the suspension axis, in metres (default [-0.15, 0.15]); the axis is Y of the chassis frame, up. */
  travel?: readonly [number, number];
  /** The most torque the drive motor applies, in N m (default Infinity). */
  maxTorque?: number;
}

/** What {@link addWheelJoint} makes. */
export interface WheelJoint {
  /** The joint between the chassis (or the steering knuckle) and the wheel. */
  readonly joint: PhysicsJoint;
  /** The knuckle a steered wheel hangs from, null when the wheel is not steerable. */
  readonly knuckle: PhysicsBody | null;
  /** Spins the wheel toward this angular speed in rad/s (positive about the wheel's axle, X of the chassis frame), with the options' torque cap. */
  drive(speed: number): void;
  /** Lets the wheel turn freely. */
  coast(): void;
  /** Turns the knuckle to an angle about the suspension axis, radians (a steerable wheel only). */
  steer(angle: number): void;
}

/**
 * A wheel joint: the wheel slides along the suspension axis (Y of the chassis frame) on a spring and a damper between travel limits,
 * and spins about the axle (X of the chassis frame), with a drive motor, as Box2D's wheel joint does. With `steerable` the wheel
 * hangs from a small knuckle body that turns about the suspension axis, so `steer(angle)` steers it. A generic joint with the other
 * four axes locked: the spring and the limits are rows like any other joint's.
 */
export function addWheelJoint(
  physics: Physics,
  chassis: PhysicsBody,
  wheel: PhysicsBody,
  options: WheelJointOptions & { steerable?: boolean } = {},
): WheelJoint {
  const {
    anchor = [0, 0, 0],
    wheelAnchor = [0, 0, 0],
    frequency = 4,
    damping = 0.7,
    travel = [-0.15, 0.15],
    maxTorque = Number.POSITIVE_INFINITY,
  } = options;
  checkVec(anchor, 'Wheel anchor');
  checkVec(wheelAnchor, 'Wheel hub');
  if (!(frequency > 0 && Number.isFinite(frequency)))
    throw new RangeError('Suspension frequency is a positive number of hertz; pass options.frequency above 0.');
  if (!(damping >= 0 && Number.isFinite(damping)))
    throw new RangeError('Suspension damping ratio is 0 or more; pass options.damping of 0 or above.');
  if (!(travel[0] <= travel[1]))
    throw new RangeError('Suspension travel is [least, greatest] with the least first; pass travel in order.');
  let knuckle: PhysicsBody | null = null,
    upper = chassis,
    upperAnchor = anchor;
  let steerJoint: PhysicsJoint | null = null;
  if (options.steerable) {
    const hub = [
      chassis.position[0] + anchor[0],
      chassis.position[1] + anchor[1],
      chassis.position[2] + anchor[2],
    ] as Vec3;
    knuckle = physics.addBody(null, {
      position: hub,
      colliders: { shape: 'sphere', radius: 0.15, mass: Math.max(wheel.mass * 0.5, 0.05), sensor: true },
    });
    steerJoint = physics.addJoint(chassis, knuckle, {
      type: 'generic',
      anchorA: anchor,
      locked: ['linX', 'linY', 'linZ', 'angX', 'angZ'],
      motors: { angY: { targetPosition: 0, frequency: 12, dampingRatio: 1 } },
    });
    upper = knuckle;
    upperAnchor = [0, 0, 0];
  }
  const joint = physics.addJoint(upper, wheel, {
    type: 'generic',
    anchorA: upperAnchor,
    anchorB: wheelAnchor,
    locked: ['linX', 'linZ', 'angY', 'angZ'],
    limits: { linY: travel },
    motors: { linY: { targetPosition: 0, frequency, dampingRatio: damping } },
  });
  return {
    joint,
    knuckle,
    drive: (speed) => void joint.setAxisMotor('angX', { targetVelocity: speed, damping: 10, maxForce: maxTorque }),
    coast: () => void joint.setAxisMotor('angX', { targetVelocity: 0, damping: 0 }),
    steer: (angle) => {
      if (!steerJoint) throw new RangeError('This wheel is not steerable; make it with steerable: true.');
      steerJoint.setAxisMotor('angY', { targetPosition: angle, frequency: 12, dampingRatio: 1 });
    },
  };
}
