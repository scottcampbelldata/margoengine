// @margoengine/cinematic/dolly: a camera on a rail. The cart goes to the point of the track nearest the subject, so the
// camera keeps pace with the subject's progress without any keyframes, and it eases there at a rate of its own.
import { closestPointOnSpline } from '@margoengine/splines/closest';
import type { Spline } from '@margoengine/splines';
import type { CameraPose } from './brain.js';
import { type CameraTarget, readTarget } from './target.js';

export type { CameraTarget } from './target.js';

/** Settings of a {@link DollyTrack}. Distances are world units along the track. */
export interface DollyTrackOptions {
  /** What the cart keeps pace with. Without one the cart stays at `position`, for you to move. Default none. */
  target?: CameraTarget;
  /** Where the cart starts, in world units from the start of the track. Default 0, or the nearest point to `target`. */
  position?: number;
  /** Stay this far ahead of the nearest point (behind when below 0). Finite. Default 0. */
  lead?: number;
  /** How fast the cart catches up, in 1/seconds, above 0. Default 4. */
  damping?: number;
  /**
   * Search only this far either side of the cart, above 0. Set it on a track that passes close to itself, so the cart
   * follows the subject along the rail instead of jumping across. Default the whole track.
   */
  window?: number;
  /** Look down the track instead of at the pose's target. Default false. */
  lookAlong?: boolean;
}

/** Samples of a windowed search, before refining. */
const STEPS = 32;
/** Golden-section steps that refine the best sample: a shrink of 0.618^40, past double precision of any real track. */
const REFINE = 40;
const GOLDEN = (Math.sqrt(5) - 1) / 2;

/**
 * A stage that puts the camera on a spline track. Put it first, before the stages that aim. With a `target` the cart
 * follows that target's progress along the track; on a closed track it takes the short way round.
 */
export class DollyTrack {
  /** What the cart keeps pace with; change it at any time. */
  target?: CameraTarget;
  /** Where the cart is, in world units from the start of the track. Write it to move the cart by hand. */
  position: number;
  /** Stay this far ahead of the nearest point; change it at any time. */
  lead: number;
  private readonly length: number;
  private readonly damping: number;
  private readonly window: number;
  private readonly lookAlong: boolean;
  private readonly start: number;
  private readonly subject = new Float64Array(3);
  private readonly point = new Float64Array(3);
  private readonly ahead = new Float64Array(3);
  private readonly closest = { t: 0, arc: 0, point: new Float64Array(3), distance: 0 };
  private started = false;
  /** @throws RangeError for a value outside what {@link DollyTrackOptions} allows, or a track of no length. */
  constructor(
    readonly track: Spline,
    options: DollyTrackOptions = {},
  ) {
    const { target, position, lead = 0, damping = 4, window = Infinity, lookAlong = false } = options;
    this.length = track.length;
    if (!(this.length > 0)) throw new RangeError('Invalid dolly track; pass a spline of some length');
    if (position !== undefined && !Number.isFinite(position))
      throw new RangeError('Invalid dolly position; pass a finite distance along the track');
    if (!Number.isFinite(lead)) throw new RangeError('Invalid dolly lead; pass a finite distance');
    if (!(damping > 0 && damping < Infinity)) throw new RangeError('Invalid dolly damping; pass a rate above 0');
    if (!(window > 0)) throw new RangeError('Invalid dolly window; pass a distance above 0');
    this.target = target;
    this.start = this.fit(position ?? 0);
    this.position = this.start;
    this.lead = lead;
    this.damping = damping;
    this.window = window;
    this.lookAlong = lookAlong;
    this.started = position !== undefined;
  }
  /** Length of the track in world units. */
  get trackLength(): number {
    return this.length;
  }
  /** Wraps a distance onto a closed track and stops it at the ends of an open one. */
  private fit(distance: number): number {
    if (this.track.closed) return ((distance % this.length) + this.length) % this.length;
    return Math.min(this.length, Math.max(0, distance));
  }
  private gap(from: number, to: number): number {
    let d = to - from;
    if (this.track.closed) {
      d %= this.length;
      if (d > this.length / 2) d -= this.length;
      else if (d < -this.length / 2) d += this.length;
    }
    return d;
  }
  private squared(arc: number): number {
    const p = this.point,
      s = this.subject;
    this.track.atDistance(this.fit(arc), p);
    return (p[0] - s[0]) ** 2 + (p[1] - s[1]) ** 2 + (p[2] - s[2]) ** 2;
  }
  /** The nearest point of the track within `window` of the cart: the best of even samples, refined by golden section. */
  private nearby(): number {
    const reach = this.window,
      closed = this.track.closed,
      low = closed ? this.position - reach : Math.max(0, this.position - reach),
      high = closed ? this.position + reach : Math.min(this.length, this.position + reach),
      size = (high - low) / STEPS;
    let best = low,
      bestValue = Infinity;
    for (let i = 0; i <= STEPS; i++) {
      const arc = low + size * i,
        value = this.squared(arc);
      if (value < bestValue) {
        bestValue = value;
        best = arc;
      }
    }
    let a = Math.max(closed ? -Infinity : low, best - size),
      b = Math.min(closed ? Infinity : high, best + size),
      c = b - GOLDEN * (b - a),
      d = a + GOLDEN * (b - a),
      fc = this.squared(c),
      fd = this.squared(d);
    for (let i = 0; i < REFINE; i++)
      if (fc < fd) {
        b = d;
        d = c;
        fd = fc;
        c = b - GOLDEN * (b - a);
        fc = this.squared(c);
      } else {
        a = c;
        c = d;
        fc = fd;
        d = a + GOLDEN * (b - a);
        fd = this.squared(d);
      }
    // The ends of a window are real answers on an open track, and the refining only nears them.
    const middle = (a + b) / 2;
    return bestValue < this.squared(middle) ? best : middle;
  }
  /** Forgets the cart's place: the next update starts it where the subject is, or where it was built to start. */
  reset(): void {
    this.position = this.start;
    this.started = false;
  }
  /** Stage hook. @throws RangeError for a bad target or a `position` that is not finite. */
  update(pose: CameraPose, delta: number): void {
    if (!Number.isFinite(this.position) || !Number.isFinite(this.lead))
      throw new RangeError('Invalid dolly position; pass a finite distance along the track');
    if (this.target !== undefined) {
      readTarget(this.target, this.subject);
      // The first search has no cart to search around.
      const whole = !this.started || this.window >= this.length,
        goal = this.fit(
          (whole ? closestPointOnSpline(this.track, this.subject, {}, this.closest).arc : this.nearby()) + this.lead,
        );
      this.position = this.started
        ? this.fit(this.position + this.gap(this.position, goal) * (1 - Math.exp(-this.damping * delta)))
        : goal;
      this.started = true;
    } else this.position = this.fit(this.position);
    const at = this.point,
      next = this.ahead;
    this.track.atDistance(this.position, at);
    pose.position[0] = at[0];
    pose.position[1] = at[1];
    pose.position[2] = at[2];
    if (this.lookAlong) {
      // A short step down the track, turned back at the far end of an open one.
      const step = Math.min(this.length / 1000, 0.01),
        end = !this.track.closed && this.position + step > this.length,
        sign = end ? -1 : 1;
      this.track.atDistance(this.fit(this.position + sign * step), next);
      for (let i = 0; i < 3; i++) pose.target[i] = at[i] + (next[i] - at[i]) * sign * (1 / step);
    }
  }
}
