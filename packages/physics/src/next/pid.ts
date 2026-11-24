// A PID controller for bodies of the own solver: it turns where a body is, and how fast it moves, into the impulse that
// drives it toward a target pose. Only + - * / on the values it holds, so a controller replays bit for bit.
import { checkVec, type Quat, type Vec3 } from '../math.js';
import { checkRotation, type PhysicsBody } from './body.js';

/** Gains and axes of a {@link PidController}. */
export interface PidOptions {
  /** Proportional gain: acceleration per unit of error, in 1/s² (default 1). */
  kp?: number;
  /** Integral gain: acceleration per unit of error summed over time, in 1/s³ (default 0). */
  ki?: number;
  /** Derivative gain: acceleration per unit of speed error, in 1/s (default 0). */
  kd?: number;
  /** The world axes the controller works on (default all three); the others read zero. */
  axes?: readonly [boolean, boolean, boolean];
}

function gain(value: number | undefined, name: string, fallback: number): number {
  const v = value ?? fallback;
  if (!(v >= 0) || v === Infinity) throw new RangeError(`PID ${name} must be a finite number of at least 0; got ${value}.`);
  return v;
}
function checkStep(dt: number): void {
  if (!(dt > 0) || dt === Infinity) throw new RangeError(`PID dt must be finite and above zero; a usual step is 1 / 60 (got ${dt}).`);
}

/**
 * A PID controller of the own solver (Rapier's `PidController`). Each call gives the acceleration that drives a body
 * toward a target, `kp` times the error, plus `ki` times the error summed over time, plus `kd` times the speed error, and
 * `applyLinear` and `applyAngular` land it as an impulse, mass times acceleration times `dt`, so a heavy body and a light
 * one follow the same path. Call once a step with the step's length. The controller keeps its integral between calls;
 * {@link PidController.reset} clears it. Gravity and contacts are not compensated: they are the error the integral takes up.
 */
export class PidController {
  kp: number;
  ki: number;
  kd: number;
  private axes: [boolean, boolean, boolean];
  private linearSum: [number, number, number] = [0, 0, 0];
  private angularSum: [number, number, number] = [0, 0, 0];

  constructor(options: PidOptions = {}) {
    this.kp = gain(options.kp, 'kp', 1);
    this.ki = gain(options.ki, 'ki', 0);
    this.kd = gain(options.kd, 'kd', 0);
    const axes = options.axes ?? [true, true, true];
    if (axes.length !== 3) throw new RangeError('PID axes must be [x, y, z] booleans.');
    this.axes = [axes[0], axes[1], axes[2]];
  }
  /** Clears what the integral has summed. */
  reset(): this {
    this.linearSum = [0, 0, 0];
    this.angularSum = [0, 0, 0];
    return this;
  }

  private command(sum: [number, number, number], dt: number, error: Vec3, rate: Vec3): [number, number, number] {
    const out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      if (!this.axes[i]) {
        sum[i] = 0;
        continue;
      }
      sum[i] += error[i] * dt;
      out[i] = this.kp * error[i] + this.ki * sum[i] + this.kd * rate[i];
    }
    return out;
  }

  /**
   * The acceleration that drives `body` to the `target` position, with `targetVelocity` the speed it should have there
   * (default at rest), in m/s². Moves the integral on by one step.
   */
  linearCorrection(dt: number, body: PhysicsBody, target: Vec3, targetVelocity: Vec3 = [0, 0, 0]): [number, number, number] {
    checkStep(dt);
    checkVec(target, 'PID target position');
    checkVec(targetVelocity, 'PID target velocity');
    const p = body.position,
      v = body.linearVelocity;
    return this.command(
      this.linearSum,
      dt,
      [target[0] - p[0], target[1] - p[1], target[2] - p[2]],
      [targetVelocity[0] - v[0], targetVelocity[1] - v[1], targetVelocity[2] - v[2]],
    );
  }
  /** Drives `body` toward `target` for one step: an impulse of its mass times {@link PidController.linearCorrection} times `dt`. */
  applyLinear(dt: number, body: PhysicsBody, target: Vec3, targetVelocity: Vec3 = [0, 0, 0]): this {
    const a = this.linearCorrection(dt, body, target, targetVelocity),
      m = body.mass * dt;
    body.applyImpulse([a[0] * m, a[1] * m, a[2] * m]);
    return this;
  }

  /**
   * The angular acceleration that turns `body` to the `target` rotation, with `targetAngularVelocity` the spin it should
   * have there (default none), in rad/s². The error is twice the vector part of the turn from the body's rotation to the
   * target, taken the short way: the turn's angle in radians to within 0.1 percent below 0.1 radian, and 2 sin(angle / 2)
   * beyond, so a large error asks a little less than its angle, never more.
   */
  angularCorrection(dt: number, body: PhysicsBody, target: Quat, targetAngularVelocity: Vec3 = [0, 0, 0]): [number, number, number] {
    checkStep(dt);
    checkRotation(target);
    checkVec(targetAngularVelocity, 'PID target angular velocity');
    const q = body.rotation,
      n = 1 / sqrtOf(target[0] * target[0] + target[1] * target[1] + target[2] * target[2] + target[3] * target[3]),
      t: Quat = [target[0] * n, target[1] * n, target[2] * n, target[3] * n],
      // target * conjugate(current): the turn that takes the body onto the target, in world axes.
      x = t[3] * -q[0] + t[0] * q[3] + t[1] * -q[2] - t[2] * -q[1],
      y = t[3] * -q[1] - t[0] * -q[2] + t[1] * q[3] + t[2] * -q[0],
      z = t[3] * -q[2] + t[0] * -q[1] - t[1] * -q[0] + t[2] * q[3],
      w = t[3] * q[3] - t[0] * -q[0] - t[1] * -q[1] - t[2] * -q[2],
      sign = w < 0 ? -2 : 2,
      s = body.angularVelocity;
    return this.command(
      this.angularSum,
      dt,
      [x * sign, y * sign, z * sign],
      [targetAngularVelocity[0] - s[0], targetAngularVelocity[1] - s[1], targetAngularVelocity[2] - s[2]],
    );
  }
  /** Turns `body` toward `target` for one step: a torque impulse of its world inertia times {@link PidController.angularCorrection} times `dt`. */
  applyAngular(dt: number, body: PhysicsBody, target: Quat, targetAngularVelocity: Vec3 = [0, 0, 0]): this {
    const a = this.angularCorrection(dt, body, target, targetAngularVelocity),
      moments = body.principalInertia,
      frame = turnBy(body.rotation, body.inertiaFrame),
      local = rotate(conjugate(frame), a),
      scaled: Vec3 = [local[0] * moments[0] * dt, local[1] * moments[1] * dt, local[2] * moments[2] * dt];
    body.applyTorqueImpulse(rotate(frame, scaled));
    return this;
  }
}

/** The square root by Newton's method from a bit-level guess, so it needs neither `Math` nor a platform's own. */
function sqrtOf(value: number): number {
  if (!(value > 0)) return 1;
  let r = value > 1 ? value : 1;
  for (let i = 0; i < 60; i++) r = 0.5 * (r + value / r);
  return r;
}
const conjugate = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
function turnBy(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
function rotate(q: Quat, v: Vec3): [number, number, number] {
  const tx = 2 * (q[1] * v[2] - q[2] * v[1]),
    ty = 2 * (q[2] * v[0] - q[0] * v[2]),
    tz = 2 * (q[0] * v[1] - q[1] * v[0]);
  return [
    v[0] + q[3] * tx + q[1] * tz - q[2] * ty,
    v[1] + q[3] * ty + q[2] * tx - q[0] * tz,
    v[2] + q[3] * tz + q[0] * ty - q[1] * tx,
  ];
}
