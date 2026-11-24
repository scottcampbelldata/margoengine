import type { Body2D } from './body.js';
import type { Vec2D } from './shapes.js';

const finite = (value: number, what: string): number => {
  if (!Number.isFinite(value)) throw new RangeError(`${what} must be a finite number, got ${value}; fix the value.`);
  return value;
};

/**
 * A proportional-integral-derivative regulator that steers a body to a target position, angle or velocity by changing its
 * velocity: the correction is `kp` times the error plus `ki` times the error summed over time plus `kd` times the
 * velocity error. Pass the fixed step length each time; call `reset` when the target jumps so the sum starts again.
 * @example const pid = new PidController2D({ kp: 8, ki: 0, kd: 1 });
 * physics.on('beforestep', (dt) => pid.applyLinear(dt, body, [200, 80]));
 */
export class PidController2D {
  kp: number;
  ki: number;
  kd: number;
  /** Which axes the linear correction acts on (default both). */
  axes: [boolean, boolean] = [true, true];
  private sum: [number, number] = [0, 0];
  private angleSum = 0;
  constructor({ kp = 1, ki = 0, kd = 0 }: { kp?: number; ki?: number; kd?: number } = {}) {
    this.kp = finite(kp, 'kp');
    this.ki = finite(ki, 'ki');
    this.kd = finite(kd, 'kd');
  }
  /** Forgets the summed error. */
  reset(): this {
    this.sum = [0, 0];
    this.angleSum = 0;
    return this;
  }
  /**
   * The change of velocity (world units per second) that moves `body` toward `target` while matching `targetVelocity`,
   * for a step of `dt` seconds. Add it to the body's velocity, or call `applyLinear`.
   */
  linearCorrection(dt: number, body: Body2D, target: Vec2D, targetVelocity: Vec2D = [0, 0]): [number, number] {
    if (!(dt > 0) || !Number.isFinite(dt)) throw new RangeError(`dt must be a finite number of seconds above 0, got ${dt}.`);
    const position = body.position,
      velocity = body.linearVelocity;
    const out: [number, number] = [0, 0];
    for (let i = 0; i < 2; i++) {
      if (!this.axes[i]) continue;
      const error = finite(target[i], 'target') - position[i];
      this.sum[i] += error * dt;
      out[i] = this.kp * error + this.ki * this.sum[i] + this.kd * (finite(targetVelocity[i], 'targetVelocity') - velocity[i]);
    }
    return out;
  }
  /** Adds the correction of {@link PidController2D.linearCorrection} to the body's velocity. */
  applyLinear(dt: number, body: Body2D, target: Vec2D, targetVelocity: Vec2D = [0, 0]): this {
    const c = this.linearCorrection(dt, body, target, targetVelocity),
      v = body.linearVelocity;
    body.linearVelocity = [v[0] + c[0] * dt, v[1] + c[1] * dt];
    return this;
  }
  /** The change of angular velocity (radians per second) toward `target` radians, by the shortest turn. */
  angularCorrection(dt: number, body: Body2D, target: number, targetVelocity = 0): number {
    if (!(dt > 0) || !Number.isFinite(dt)) throw new RangeError(`dt must be a finite number of seconds above 0, got ${dt}.`);
    let error = (finite(target, 'target') - body.rotation) % (2 * Math.PI);
    if (error > Math.PI) error -= 2 * Math.PI;
    else if (error < -Math.PI) error += 2 * Math.PI;
    this.angleSum += error * dt;
    return this.kp * error + this.ki * this.angleSum + this.kd * (finite(targetVelocity, 'targetVelocity') - body.angularVelocity);
  }
  /** Adds the correction of {@link PidController2D.angularCorrection} to the body's angular velocity. */
  applyAngular(dt: number, body: Body2D, target: number, targetVelocity = 0): this {
    body.angularVelocity += this.angularCorrection(dt, body, target, targetVelocity) * dt;
    return this;
  }
}
