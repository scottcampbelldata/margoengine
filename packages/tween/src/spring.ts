import { MargoError } from '@margoengine/math/errors';

/** Spring parameters. Defaults give a quick, slightly bouncy settle (damping ratio about 0.5). */
export interface SpringOptions {
  /** Start value. Default 0. */
  value?: number;
  /** Rest value the spring pulls toward. Default: `value`. */
  target?: number;
  /** Start velocity in units per second. Default 0. */
  velocity?: number;
  /** Spring constant `k`, > 0. Default 170. */
  stiffness?: number;
  /** Damping coefficient `c`, >= 0. Default 14. Critical damping is `2 * sqrt(stiffness * mass)`. */
  damping?: number;
  /** Mass, > 0. Default 1. */
  mass?: number;
  /** The spring counts as settled when both |value - target| and |velocity| fall below this. Default 0.001. */
  precision?: number;
}

/**
 * A damped spring for smooth, interruptible motion: change `target` at any time and the value follows with its
 * velocity carried over. Stepped with the exact closed-form solution of the damped harmonic oscillator, so any frame
 * time (even a long hitch) is stable and never overshoots more than the physics says.
 *
 * ```ts
 * const spring = new Spring({value: 0, stiffness: 120, damping: 12});
 * spring.target = 1;
 * spring.update(1 / 60); // spring.value moves toward 1
 * ```
 */
export class Spring {
  value: number;
  target: number;
  velocity: number;
  readonly stiffness: number;
  readonly damping: number;
  readonly mass: number;
  readonly precision: number;
  /**
   * @throws RangeError for a non-finite number, `stiffness` or `mass` not above 0, or `damping` or `precision` below 0.
   */
  constructor({
    value = 0,
    target = value,
    velocity = 0,
    stiffness = 170,
    damping = 14,
    mass = 1,
    precision = 0.001,
  }: SpringOptions = {}) {
    if (
      ![value, target, velocity, stiffness, damping, mass, precision].every(Number.isFinite) ||
      stiffness <= 0 ||
      mass <= 0 ||
      damping < 0 ||
      precision < 0
    )
      throw new RangeError('Invalid spring; use finite numbers with stiffness and mass above 0 and damping at least 0');
    this.value = value;
    this.target = target;
    this.velocity = velocity;
    this.stiffness = stiffness;
    this.damping = damping;
    this.mass = mass;
    this.precision = precision;
  }
  /** Damping ratio: below 1 the spring overshoots and rings, at 1 it is critically damped, above 1 it creeps in. */
  get dampingRatio(): number {
    return this.damping / (2 * Math.sqrt(this.stiffness * this.mass));
  }
  /** True when the value is within `precision` of the target and (nearly) at rest. */
  get settled(): boolean {
    return Math.abs(this.value - this.target) <= this.precision && Math.abs(this.velocity) <= this.precision;
  }
  /**
   * Advance by `delta` seconds and return the new value. Snaps to the target once settled.
   * @throws RangeError when `delta` is negative or not finite.
   * @throws MargoError `'state'` when the value, target or velocity was set to a non-finite number.
   */
  update(delta: number): number {
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid spring delta; pass seconds as a finite number >= 0');
    if (!Number.isFinite(this.value + this.target + this.velocity))
      throw new MargoError('state', 'Spring value, target and velocity must stay finite; assign finite numbers');
    if (delta === 0) return this.value;
    const w0 = Math.sqrt(this.stiffness / this.mass),
      zeta = this.dampingRatio,
      x0 = this.value - this.target,
      v0 = this.velocity;
    let x: number, v: number;
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta),
        e = Math.exp(-zeta * w0 * delta),
        c = Math.cos(wd * delta),
        s = Math.sin(wd * delta),
        b = (v0 + zeta * w0 * x0) / wd;
      x = e * (x0 * c + b * s);
      v = e * (v0 * c - (x0 * wd + (zeta * w0 * (v0 + zeta * w0 * x0)) / wd) * s);
    } else if (zeta === 1) {
      const e = Math.exp(-w0 * delta),
        b = v0 + w0 * x0;
      x = e * (x0 + b * delta);
      v = e * (v0 - w0 * b * delta);
    } else {
      const r = w0 * Math.sqrt(zeta * zeta - 1),
        r1 = -zeta * w0 + r,
        r2 = -zeta * w0 - r,
        c2 = (v0 - r1 * x0) / (r2 - r1),
        c1 = x0 - c2,
        e1 = Math.exp(r1 * delta),
        e2 = Math.exp(r2 * delta);
      x = c1 * e1 + c2 * e2;
      v = c1 * r1 * e1 + c2 * r2 * e2;
    }
    this.value = this.target + x;
    this.velocity = v;
    if (this.settled) {
      this.value = this.target;
      this.velocity = 0;
    }
    return this.value;
  }
}
