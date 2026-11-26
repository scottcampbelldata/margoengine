import type { OrbitControls } from './orbit.js';
import type { CameraTransitions, FitOptions } from './transitions.js';
import { rangeError } from '../../shared/errors.js';

/** Elastic overshoot past the dolly limits. */
export interface BounceOptions {
  /** Soft closest distance the view settles to. Default the control's `minDistance`. */
  min?: number;
  /** Soft farthest distance the view settles to. Default the control's `maxDistance`. */
  max?: number;
  /** How far past a soft limit the user can push, as a fraction of that limit. Default 0.2. */
  overshoot?: number;
  /** Spring stiffness in 1/s^2: higher snaps back faster. Default 120. */
  stiffness?: number;
  /** Damping ratio: 1 (default) settles with no swing; below 1 the spring undershoots the limit once and stops there. */
  damping?: number;
}
/** Settings of {@link OrbitBehaviors}; each behaviour is off until its option is given. */
export interface OrbitBehaviorOptions {
  /** Rate-limited elastic bounce at the dolly limits. */
  bounce?: BounceOptions | boolean;
  /** Turn around the target after `wait` seconds without input, and stop at the next input. */
  autoRotate?: { wait?: number; speed?: number } | boolean;
}
type Box = { min: readonly number[]; max: readonly number[] } | { bounds: ArrayLike<number> };

/**
 * Optional behaviours layered on `OrbitControls`: an elastic bounce at the dolly limits, idle auto-rotation that waits
 * and stops on input, and animated framing of a box or model bounds. Call `update(delta)` right before the control's
 * own `update(delta)` every frame.
 *
 * The bounce widens the control's hard limits by `overshoot` and springs the distance back to the soft limits once the
 * input ends (a damped spring, Hooke's law with viscous damping, integrated in small fixed sub-steps). Auto-rotation sets
 * the control's own `autoRotate` when the idle time has passed.
 */
export class OrbitBehaviors {
  private idle = 0;
  private busy = false;
  private velocity = 0;
  private disposed = false;
  private readonly spring: { min: number; max: number; overshoot: number; k: number; zeta: number } | null;
  private readonly rotate: { wait: number; speed: number } | null;
  private readonly start = (): void => {
    this.busy = true;
    this.idle = 0;
    this.velocity = 0;
  };
  private readonly end = (): void => {
    this.busy = false;
    this.idle = 0;
  };
  constructor(
    private readonly controls: OrbitControls & { transitions?: CameraTransitions },
    options: OrbitBehaviorOptions = {},
  ) {
    const b = options.bounce === true ? {} : options.bounce,
      r = options.autoRotate === true ? {} : options.autoRotate;
    const bad = (m: string): never => {
      throw rangeError(`OrbitBehaviors: ${m}; pass valid options`, 'controls-arguments');
    };
    this.spring = b
      ? {
          min: b.min ?? controls.minDistance,
          max: b.max ?? controls.maxDistance,
          overshoot: b.overshoot ?? 0.2,
          k: b.stiffness ?? 120,
          zeta: b.damping ?? 1,
        }
      : null;
    if (this.spring) {
      const s = this.spring;
      if (!(s.min >= 0) || !(s.max > s.min) || !(s.overshoot >= 0) || !(s.k > 0) || !(s.zeta > 0))
        bad('bounce needs 0 <= min < max, overshoot >= 0, stiffness > 0 and damping > 0');
      if (Number.isFinite(s.min) && s.overshoot > 0) controls.minDistance = s.min * (1 - Math.min(s.overshoot, 0.99));
      if (Number.isFinite(s.max)) controls.maxDistance = s.max * (1 + s.overshoot);
    }
    this.rotate = r ? { wait: r.wait ?? 3, speed: r.speed ?? controls.autoRotateSpeed } : null;
    if (this.rotate && !(this.rotate.wait >= 0 && Number.isFinite(this.rotate.speed)))
      bad('autoRotate needs wait >= 0 and a finite speed');
    controls.autoRotate = false;
    controls.addEventListener('start', this.start);
    controls.addEventListener('end', this.end);
  }
  /** Seconds since the last input. */
  get idleTime(): number {
    return this.idle;
  }
  /** Advances the idle timer, the bounce spring and auto-rotation by `delta` seconds. Returns true when the spring moved the camera. */
  update(delta = 1 / 60): boolean {
    if (this.disposed) return false;
    const c = this.controls;
    if (!this.busy) this.idle += Math.max(0, delta);
    if (this.rotate) {
      c.autoRotateSpeed = this.rotate.speed;
      c.autoRotate = !this.busy && this.idle >= this.rotate.wait && !c.transitions?.active;
    }
    const s = this.spring;
    if (!s || this.busy || delta <= 0 || c.transitions?.active) return false;
    const cam = c.camera,
      t = cam.target,
      p = cam.position;
    const ox = p[0] - t[0],
      oy = p[1] - t[1],
      oz = p[2] - t[2],
      d = Math.hypot(ox, oy, oz);
    const goal = Math.min(s.max, Math.max(s.min, d)),
      x = d - goal;
    if (!(d > 0) || Math.abs(x) < 1e-6) return (this.velocity = 0), false;
    // Semi-implicit Euler in sub-steps of at most 1/240 s keeps the spring stable at any frame length.
    const n = Math.max(1, Math.ceil(delta * 240)),
      h = delta / n,
      w = 2 * s.zeta * Math.sqrt(s.k);
    let pos = x;
    for (let i = 0; i < n; i++) {
      this.velocity += (-s.k * pos - w * this.velocity) * h;
      pos += this.velocity * h;
    }
    if (Math.abs(pos) < 1e-5 && Math.abs(this.velocity) < 1e-4) (pos = 0), (this.velocity = 0);
    const next = Math.max(1e-6, goal + pos),
      k = next / d;
    cam.position = [t[0] + ox * k, t[1] + oy * k, t[2] + oz * k];
    return true;
  }
  /**
   * Animates the camera to frame a box (`{min, max}`) or a model's `bounds` (six numbers: min then max) with the
   * control's `transitions`. Resolves true when the move completes, false when input or another move cancels it.
   * @throws RangeError when the control is not the `/transitions` kind.
   */
  frame(target: Box, options: FitOptions = {}): Promise<boolean> {
    const moves = this.controls.transitions;
    if (!moves)
      throw rangeError('OrbitBehaviors.frame needs OrbitControls imported from @margoengine/controls/transitions; import it from there', 'controls-arguments');
    const b = 'bounds' in target ? target.bounds : null;
    const box = b
      ? { min: [b[0], b[1], b[2]] as [number, number, number], max: [b[3], b[4], b[5]] as [number, number, number] }
      : (target as { min: [number, number, number]; max: [number, number, number] });
    return moves.fitToBox(box, options);
  }
  /** Stops listening and restores the control's own `autoRotate` to false. Limits stay as widened. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controls.removeEventListener('start', this.start);
    this.controls.removeEventListener('end', this.end);
    this.controls.autoRotate = false;
  }
  declare [Symbol.dispose]: () => void;
}
OrbitBehaviors.prototype[Symbol.dispose] = OrbitBehaviors.prototype.dispose;
