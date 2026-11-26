// PID and PD controllers for bodies of the own solver: they turn where a body is, and how fast it moves, into the impulse
// that drives it toward a target pose. Only + - * / and square roots on the values they hold, so a controller replays
// bit for bit.
//
// The control law is the textbook parallel PID (Astrom and Murray, "Feedback Systems", 2008, ch. 10; Astrom and
// Hagglund, "Advanced PID Control", ISA 2006, ch. 3): an acceleration kp e + ki sum(e dt) + kd de/dt on each axis,
// landed as an impulse of mass (or inertia) times the acceleration times the step, so the closed loop of any body is the
// unit-mass loop s^2 + kd s + kp. A cap on the acceleration (an actuator's limit) uses conditional integration against
// windup (Astrom and Hagglund 2006, sec. 3.5; Visioli, "Modified anti-windup scheme for PID controllers", IEE Proc.
// Control Theory Appl. 150, 2003): while the command is held at the cap, the integral does not grow.
import { checkVec, type Quat, type Vec3 } from './math.js';
import { checkRotation, type PhysicsBody } from './body.js';

/** A mask of world axes, `[x, y, z]`: true where a controller works. */
export type PidAxisMask = readonly [boolean, boolean, boolean];
type Axes = PidAxisMask;
type V3 = [number, number, number];

/** The axes a controller works on: one `[x, y, z]` mask for both parts, or one for each. */
export interface PidAxes {
  /** World axes of the linear part (default all three). */
  linear?: PidAxisMask;
  /** World axes of the angular part (default all three). */
  angular?: PidAxisMask;
}

/** Gains of one part of a controller. */
export interface PidGains {
  /** Proportional gain: acceleration per unit of error, in 1/s² (default 1). */
  kp?: number;
  /** Integral gain: acceleration per unit of error summed over time, in 1/s³ (default 0). */
  ki?: number;
  /** Derivative gain: acceleration per unit of speed error, in 1/s (default 0). */
  kd?: number;
}

/** Gains, axes and caps of a {@link PidController}. */
export interface PidOptions extends PidGains {
  /** Gains of the angular part (each defaults to the linear gain of its name). */
  angular?: PidGains;
  /** The world axes the controller works on (default all three); the others read zero. */
  axes?: PidAxisMask | PidAxes;
  /** Largest linear acceleration it asks for, m/s² (default `Infinity`); the integral holds while it is at the cap. */
  maxLinear?: number;
  /** Largest angular acceleration it asks for, rad/s² (default `Infinity`). */
  maxAngular?: number;
}

/** Gains, axes and caps of a {@link PdController}. */
export interface PdOptions {
  /** Proportional gain, 1/s² (default 1). */
  kp?: number;
  /** Derivative gain, 1/s (default 0). */
  kd?: number;
  /** Gains of the angular part (each defaults to the linear gain of its name). */
  angular?: { kp?: number; kd?: number };
  axes?: PidAxisMask | PidAxes;
  maxLinear?: number;
  maxAngular?: number;
}

/**
 * How far a body is from its target, and how far its speeds are from the target's (Rapier's `PdErrors`): `linear` is the
 * target position less the body's, m; `angular` twice the vector part of the short turn from the body's rotation to the
 * target's, rad; `linearVelocity` and `angularVelocity` the target's speeds less the body's.
 */
export interface PdErrors {
  linear: [number, number, number];
  angular: [number, number, number];
  linearVelocity: [number, number, number];
  angularVelocity: [number, number, number];
}

/** A target pose: a part left out is not controlled (its error reads zero). */
export interface PidPose {
  position?: Vec3;
  rotation?: Quat;
}
/** A target's speeds (default at rest). */
export interface PidVelocity {
  linear?: Vec3;
  angular?: Vec3;
}
/** The accelerations a controller asks for: linear m/s², angular rad/s². */
export interface PidCorrection {
  linear: [number, number, number];
  angular: [number, number, number];
}

function gain(value: number | undefined, name: string, fallback: number): number {
  const v = value ?? fallback;
  if (!(v >= 0) || v === Infinity)
    throw new RangeError(`PID ${name} must be a finite number of at least 0; got ${value}.`);
  return v;
}
function cap(value: number | undefined, name: string): number {
  const v = value ?? Infinity;
  if (!(v > 0)) throw new RangeError(`PID ${name} must be above 0 or Infinity; got ${value}.`);
  return v;
}
function checkStep(dt: number): void {
  if (!(dt > 0) || dt === Infinity)
    throw new RangeError(`PID dt must be finite and above zero; a usual step is 1 / 60 (got ${dt}).`);
}
function mask(value: Axes | undefined, name: string): [boolean, boolean, boolean] {
  const axes = value ?? [true, true, true];
  if (axes.length !== 3) throw new RangeError(`PID ${name} axes must be [x, y, z] booleans.`);
  return [!!axes[0], !!axes[1], !!axes[2]];
}
function axesOf(value: Axes | PidAxes | undefined): [[boolean, boolean, boolean], [boolean, boolean, boolean]] {
  if (value === undefined || Array.isArray(value)) {
    const both = mask(value as Axes | undefined, 'the');
    return [both, [both[0], both[1], both[2]]];
  }
  const split = value as PidAxes;
  return [mask(split.linear, 'linear'), mask(split.angular, 'angular')];
}
const ZERO: Vec3 = [0, 0, 0];

/** The linear error of `body` against a target position and velocity. */
function linearErrors(body: PhysicsBody, target: Vec3, targetVelocity: Vec3): [V3, V3] {
  checkVec(target, 'PID target position');
  checkVec(targetVelocity, 'PID target velocity');
  const p = body.position,
    v = body.linearVelocity;
  return [
    [target[0] - p[0], target[1] - p[1], target[2] - p[2]],
    [targetVelocity[0] - v[0], targetVelocity[1] - v[1], targetVelocity[2] - v[2]],
  ];
}
/**
 * The angular error of `body` against a target rotation and spin: twice the vector part of the turn from the body's
 * rotation to the target, taken the short way, which is the turn's angle in radians to within 0.1 percent below 0.1
 * radian and 2 sin(angle / 2) beyond, so a large error asks a little less than its angle, never more.
 */
function angularErrors(body: PhysicsBody, target: Quat, targetAngularVelocity: Vec3): [V3, V3] {
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
  return [
    [x * sign, y * sign, z * sign],
    [targetAngularVelocity[0] - s[0], targetAngularVelocity[1] - s[1], targetAngularVelocity[2] - s[2]],
  ];
}

/**
 * The errors of `body` against a target `pose` and `velocity` (Rapier's `PdErrors`). A part of the pose left out reads
 * zero error, its speed error included, so a controller given these errors leaves it alone.
 */
export function pdErrors(body: PhysicsBody, pose: PidPose, velocity: PidVelocity = {}): PdErrors {
  const [linear, linearVelocity] = pose.position
      ? linearErrors(body, pose.position, velocity.linear ?? ZERO)
      : [[0, 0, 0] as V3, [0, 0, 0] as V3],
    [angular, angularVelocity] = pose.rotation
      ? angularErrors(body, pose.rotation, velocity.angular ?? ZERO)
      : [[0, 0, 0] as V3, [0, 0, 0] as V3];
  return { linear, angular, linearVelocity, angularVelocity };
}

/** Lands a linear acceleration on `body` for one step: an impulse of its mass times `a` times `dt`. */
function landLinear(body: PhysicsBody, a: Vec3, dt: number): void {
  const m = body.mass * dt;
  body.applyImpulse([a[0] * m, a[1] * m, a[2] * m]);
}
/** Lands an angular acceleration on `body` for one step: a torque impulse of its world inertia times `a` times `dt`. */
function landAngular(body: PhysicsBody, a: Vec3, dt: number): void {
  const moments = body.principalInertia,
    frame = turnBy(body.rotation, body.inertiaFrame),
    local = rotate(conjugate(frame), a),
    scaled: Vec3 = [local[0] * moments[0] * dt, local[1] * moments[1] * dt, local[2] * moments[2] * dt];
  body.applyTorqueImpulse(rotate(frame, scaled));
}
/** Scales `out` down to length `limit` when it is longer; true when it did. */
function saturate(out: V3, limit: number): boolean {
  if (limit === Infinity) return false;
  const length = sqrtOf(out[0] * out[0] + out[1] * out[1] + out[2] * out[2]);
  if (!(length > limit)) return false;
  const s = limit / length;
  out[0] *= s;
  out[1] *= s;
  out[2] *= s;
  return true;
}

/** One part's command: kp e + ki (sum + e dt) + kd rate on the axes of `axes`, capped to `limit`; commits the sum unless capped. */
function command(
  kp: number,
  ki: number,
  kd: number,
  axes: readonly boolean[],
  sum: V3 | null,
  dt: number,
  error: Vec3,
  rate: Vec3,
  limit: number,
): [number, number, number] {
  const out: V3 = [0, 0, 0],
    next: V3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (!axes[i]) {
      if (sum) sum[i] = 0;
      continue;
    }
    if (sum) {
      next[i] = sum[i] + error[i] * dt;
      out[i] = kp * error[i] + ki * next[i] + kd * rate[i];
    } else out[i] = kp * error[i] + kd * rate[i];
  }
  // Conditional integration: while the command is at its cap the integral holds where it was.
  if (!saturate(out, limit) && sum) for (let i = 0; i < 3; i++) if (axes[i]) sum[i] = next[i];
  return out;
}

/** The gains, axes and caps both {@link PdController} and {@link PidController} hold. */
export abstract class PidControllerBase {
  /** Linear proportional gain, 1/s². */
  kp: number;
  /** Linear derivative gain, 1/s. */
  kd: number;
  /** Angular proportional gain, 1/s². */
  angularKp: number;
  /** Angular derivative gain, 1/s. */
  angularKd: number;
  /** Largest linear acceleration asked for, m/s² (`Infinity` for none). */
  maxLinear: number;
  /** Largest angular acceleration asked for, rad/s² (`Infinity` for none). */
  maxAngular: number;
  protected linearAxes: [boolean, boolean, boolean];
  protected angularAxes: [boolean, boolean, boolean];

  constructor(options: PdOptions) {
    this.kp = gain(options.kp, 'kp', 1);
    this.kd = gain(options.kd, 'kd', 0);
    this.angularKp = gain(options.angular?.kp, 'angular kp', this.kp);
    this.angularKd = gain(options.angular?.kd, 'angular kd', this.kd);
    this.maxLinear = cap(options.maxLinear, 'maxLinear');
    this.maxAngular = cap(options.maxAngular, 'maxAngular');
    [this.linearAxes, this.angularAxes] = axesOf(options.axes);
  }
  /** The world axes each part works on (Rapier's `axes`); a copy. */
  get axes(): { linear: [boolean, boolean, boolean]; angular: [boolean, boolean, boolean] } {
    return { linear: [...this.linearAxes], angular: [...this.angularAxes] };
  }
  /** Sets the axes (Rapier's `set_axes`): one mask for both parts, or one for each. A part's integral is cleared on an axis it leaves. */
  setAxes(axes: PidAxisMask | PidAxes): this {
    [this.linearAxes, this.angularAxes] = axesOf(axes);
    return this;
  }
}

/**
 * A PD controller of the own solver (Rapier's `PdController`): each call gives the acceleration that drives a body toward
 * a target, `kp` times the error plus `kd` times the speed error, with no memory between calls. `apply`, `applyLinear`
 * and `applyAngular` land it as an impulse of mass (or world inertia) times acceleration times `dt`, so a heavy body and
 * a light one follow the same path. {@link pdErrors} reads the errors it acts on.
 */
export class PdController extends PidControllerBase {
  constructor(options: PdOptions = {}) {
    super(options);
  }
  /** The accelerations the errors ask for. */
  correction(errors: PdErrors): PidCorrection {
    return {
      linear: command(
        this.kp,
        0,
        this.kd,
        this.linearAxes,
        null,
        0,
        errors.linear,
        errors.linearVelocity,
        this.maxLinear,
      ),
      angular: command(
        this.angularKp,
        0,
        this.angularKd,
        this.angularAxes,
        null,
        0,
        errors.angular,
        errors.angularVelocity,
        this.maxAngular,
      ),
    };
  }
  /** The acceleration that drives `body` to `target` moving at `targetVelocity` (default at rest), m/s². */
  linearCorrection(body: PhysicsBody, target: Vec3, targetVelocity: Vec3 = ZERO): [number, number, number] {
    const [e, r] = linearErrors(body, target, targetVelocity);
    return command(this.kp, 0, this.kd, this.linearAxes, null, 0, e, r, this.maxLinear);
  }
  /** The angular acceleration that turns `body` to `target` spinning at `targetAngularVelocity` (default none), rad/s². */
  angularCorrection(body: PhysicsBody, target: Quat, targetAngularVelocity: Vec3 = ZERO): [number, number, number] {
    const [e, r] = angularErrors(body, target, targetAngularVelocity);
    return command(this.angularKp, 0, this.angularKd, this.angularAxes, null, 0, e, r, this.maxAngular);
  }
  /** Drives `body` toward `target` for one step of `dt` seconds. */
  applyLinear(dt: number, body: PhysicsBody, target: Vec3, targetVelocity: Vec3 = ZERO): this {
    checkStep(dt);
    landLinear(body, this.linearCorrection(body, target, targetVelocity), dt);
    return this;
  }
  /** Turns `body` toward `target` for one step of `dt` seconds. */
  applyAngular(dt: number, body: PhysicsBody, target: Quat, targetAngularVelocity: Vec3 = ZERO): this {
    checkStep(dt);
    landAngular(body, this.angularCorrection(body, target, targetAngularVelocity), dt);
    return this;
  }
  /** Drives `body` toward a whole `pose` for one step; a part the pose leaves out is not driven. */
  apply(dt: number, body: PhysicsBody, pose: PidPose, velocity: PidVelocity = {}): this {
    checkStep(dt);
    const { linear, angular } = this.correction(pdErrors(body, pose, velocity));
    if (pose.position) landLinear(body, linear, dt);
    if (pose.rotation) landAngular(body, angular, dt);
    return this;
  }
}

/**
 * A PID controller of the own solver (Rapier's `PidController`). Each call gives the acceleration that drives a body
 * toward a target, `kp` times the error, plus `ki` times the error summed over time, plus `kd` times the speed error, and
 * `apply`, `applyLinear` and `applyAngular` land it as an impulse, mass times acceleration times `dt`, so a heavy body and
 * a light one follow the same path. Call once a step with the step's length. The controller keeps its integrals between
 * calls; {@link PidController.reset} clears them. Gravity and contacts are not compensated: they are the error the
 * integral takes up. With `maxLinear` or `maxAngular` a command is held at its cap and its integral stops growing there.
 */
export class PidController extends PidControllerBase {
  /** Linear integral gain, 1/s³. */
  ki: number;
  /** Angular integral gain, 1/s³. */
  angularKi: number;
  private linearSum: V3 = [0, 0, 0];
  private angularSum: V3 = [0, 0, 0];

  constructor(options: PidOptions = {}) {
    super(options);
    this.ki = gain(options.ki, 'ki', 0);
    this.angularKi = gain(options.angular?.ki, 'angular ki', this.ki);
  }
  /** Clears what the integrals have summed (Rapier's `reset_integrals`). */
  reset(): this {
    this.linearSum = [0, 0, 0];
    this.angularSum = [0, 0, 0];
    return this;
  }
  /** The linear error summed over time so far, m s; a copy. */
  get linearIntegral(): [number, number, number] {
    return [...this.linearSum];
  }
  /** The angular error summed over time so far, rad s; a copy. */
  get angularIntegral(): [number, number, number] {
    return [...this.angularSum];
  }

  /** The accelerations `errors` ask for over a step of `dt` seconds; moves both integrals on by the step. */
  correction(dt: number, errors: PdErrors): PidCorrection {
    checkStep(dt);
    return {
      linear: command(
        this.kp,
        this.ki,
        this.kd,
        this.linearAxes,
        this.linearSum,
        dt,
        errors.linear,
        errors.linearVelocity,
        this.maxLinear,
      ),
      angular: command(
        this.angularKp,
        this.angularKi,
        this.angularKd,
        this.angularAxes,
        this.angularSum,
        dt,
        errors.angular,
        errors.angularVelocity,
        this.maxAngular,
      ),
    };
  }
  /**
   * The acceleration that drives `body` to the `target` position, with `targetVelocity` the speed it should have there
   * (default at rest), in m/s². Moves the linear integral on by one step.
   */
  linearCorrection(dt: number, body: PhysicsBody, target: Vec3, targetVelocity: Vec3 = ZERO): [number, number, number] {
    checkStep(dt);
    const [e, r] = linearErrors(body, target, targetVelocity);
    return command(this.kp, this.ki, this.kd, this.linearAxes, this.linearSum, dt, e, r, this.maxLinear);
  }
  /** Drives `body` toward `target` for one step: an impulse of its mass times {@link PidController.linearCorrection} times `dt`. */
  applyLinear(dt: number, body: PhysicsBody, target: Vec3, targetVelocity: Vec3 = ZERO): this {
    landLinear(body, this.linearCorrection(dt, body, target, targetVelocity), dt);
    return this;
  }
  /**
   * The angular acceleration that turns `body` to the `target` rotation, with `targetAngularVelocity` the spin it should
   * have there (default none), in rad/s². The error is twice the vector part of the turn from the body's rotation to the
   * target, taken the short way: the turn's angle in radians to within 0.1 percent below 0.1 radian, and 2 sin(angle / 2)
   * beyond, so a large error asks a little less than its angle, never more. Moves the angular integral on by one step.
   */
  angularCorrection(
    dt: number,
    body: PhysicsBody,
    target: Quat,
    targetAngularVelocity: Vec3 = ZERO,
  ): [number, number, number] {
    checkStep(dt);
    const [e, r] = angularErrors(body, target, targetAngularVelocity);
    return command(
      this.angularKp,
      this.angularKi,
      this.angularKd,
      this.angularAxes,
      this.angularSum,
      dt,
      e,
      r,
      this.maxAngular,
    );
  }
  /** Turns `body` toward `target` for one step: a torque impulse of its world inertia times {@link PidController.angularCorrection} times `dt`. */
  applyAngular(dt: number, body: PhysicsBody, target: Quat, targetAngularVelocity: Vec3 = ZERO): this {
    landAngular(body, this.angularCorrection(dt, body, target, targetAngularVelocity), dt);
    return this;
  }
  /**
   * Drives `body` toward a whole `pose` for one step (Rapier's `rigid_body_correction`, landed); a part the pose leaves
   * out is not driven and its integral does not move.
   */
  apply(dt: number, body: PhysicsBody, pose: PidPose, velocity: PidVelocity = {}): this {
    if (pose.position) this.applyLinear(dt, body, pose.position, velocity.linear ?? ZERO);
    if (pose.rotation) this.applyAngular(dt, body, pose.rotation, velocity.angular ?? ZERO);
    if (!pose.position && !pose.rotation) checkStep(dt);
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
