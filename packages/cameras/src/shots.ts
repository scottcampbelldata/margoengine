import type { Camera, Vec3 } from '@margoengine/core/extension';
import { lerp } from '@margoengine/math/mathutils';
import { rangeError } from '../../shared/errors.js';

// Two framed views of one exhibit (a whole bench and a close-up, say) and an eased move between them, so a scene's
// "Inspect" button is one property instead of a dozen lines of camera maths in every page.
//
// A shot is an eye-target pair written as a target and an eye offset from it (J. Blinn, "Where am I? What am I looking
// at?", IEEE Computer Graphics and Applications 8(4), 1988). Between two shots the target, the offset, the portrait
// back-off and the field of view are blended linearly by one weight b. b eases toward its goal by exponential smoothing,
// b <- goal + (b - goal) e^(-rate dt) (R. G. Brown, "Smoothing, Forecasting and Prediction of Discrete Time Series",
// 1963), which reaches the same place after the same time at any frame rate, and snaps once within 0.001 of the goal so
// the move ends in finite frames. Narrow (portrait) views back the eye away along the offset by max(1, fit h / w), so
// the exhibit that fits a landscape frame still fits a phone held upright.

/** One framed view: the eye sits at `target + offset * max(1, fit * height / width)`. */
export interface Shot {
  /** Point the camera looks at, in world units. Read on every update, so it may be changed in place. */
  target: Vec3;
  /** Eye position relative to `target` for a landscape view. */
  offset: Vec3;
  /** How much a portrait view backs away: the offset is scaled by max(1, fit * height / width). Default 1. */
  fit?: number;
  /** Vertical field of view in degrees. Set on the camera only when both shots give one. */
  fov?: number;
}

/** Options for {@link ShotBlend}. */
export interface ShotBlendOptions {
  /** Exponential easing rate per second; 15 settles to 0.001 in about 0.46 s. Default 15. */
  rate?: number;
  /** Jumps straight to the goal while `matches` is true, as for `matchMedia('(prefers-reduced-motion: reduce)')`. */
  still?: { readonly matches: boolean };
}

/** Frames a camera at, or on the way between, two {@link Shot}s. */
export class ShotBlend {
  /** Shot at blend 0. */
  readonly from: Shot;
  /** Shot at blend 1. */
  readonly to: Shot;
  /** Where the blend is heading: 0 for `from`, 1 for `to`, or any value between. Default 0. */
  goal = 0;
  /** The current blend, which eases toward {@link goal} on each update. Starts at 0. */
  blend = 0;
  readonly #camera: Camera;
  readonly #rate: number;
  readonly #still?: { readonly matches: boolean };

  constructor(camera: Camera, from: Shot, to: Shot, { rate = 15, still }: ShotBlendOptions = {}) {
    if (!(rate > 0) || !Number.isFinite(rate)) throw rangeError('ShotBlend rate must be a finite number above 0', 'cameras');
    this.#camera = camera;
    this.from = from;
    this.to = to;
    this.#rate = rate;
    this.#still = still;
  }

  /** True while the blend has not reached its goal. */
  get moving(): boolean {
    return this.blend !== this.goal;
  }

  /**
   * Eases the blend toward the goal over `delta` seconds and frames the camera for a `width` x `height` view. Returns
   * true while the blend is still moving, so a page that renders on demand knows to draw another frame.
   */
  update(delta: number, width: number, height: number): boolean {
    if (!(delta >= 0) || !Number.isFinite(delta)) throw rangeError('ShotBlend delta must be a finite number of seconds >= 0', 'cameras');
    if (!(width > 0 && height > 0)) throw rangeError('ShotBlend width and height must be above 0', 'cameras');
    const { from, to, goal } = this;
    const b = (this.blend =
      this.#still?.matches || Math.abs(this.blend - goal) < 0.001 ? goal : lerp(goal, this.blend, Math.exp(-delta * this.#rate)));
    const fit = Math.max(1, (lerp(from.fit ?? 1, to.fit ?? 1, b) * height) / width);
    const at = (i: number) => lerp(from.target[i], to.target[i], b);
    const target: Vec3 = [at(0), at(1), at(2)];
    const eye = (i: number) => target[i] + fit * lerp(from.offset[i], to.offset[i], b);
    this.#camera.target = target;
    this.#camera.position = [eye(0), eye(1), eye(2)];
    if (from.fov !== undefined && to.fov !== undefined) this.#camera.fov = lerp(from.fov, to.fov, b);
    return this.moving;
  }
}
