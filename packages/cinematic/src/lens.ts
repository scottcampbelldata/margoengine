// @margoengine/cinematic/lens: a focus puller and a zoom operator. Focus follows the subject along the view axis, the
// measure a lens and the DOF effect both use, and the field of view can hold the subject at one size on screen.
import type { CameraPose, CameraStage } from './brain.js';
import { type CameraTarget, readTarget } from './target.js';

export type { CameraTarget } from './target.js';

/** Settings of a {@link FocusTracker}. */
export interface FocusTrackerOptions {
  /** How fast focus follows, in 1/seconds, above 0. Lower is a slow rack. Default 6. */
  focusDamping?: number;
  /** Added to the distance, to focus in front of or behind the point (a face, not the feet). Finite. Default 0. */
  focusOffset?: number;
  /** Nearest focus, above 0. Keep it beyond the lens's focal length. Default 0.1. */
  minFocus?: number;
  /** Height of the subject in world units, above 0. With `screenHeight` it drives the field of view. Default none. */
  size?: number;
  /** Share of the screen height the subject should fill, above 0 and at most 1. Default 0.5. */
  screenHeight?: number;
  /** How fast the field of view follows, in 1/seconds, above 0. Default 4. */
  fovDamping?: number;
  /** Narrowest field of view in degrees. Default 10. */
  minFov?: number;
  /** Widest field of view in degrees, at least `minFov`, below 180. Default 100. */
  maxFov?: number;
}

/**
 * A stage that sets `pose.focusDistance` from `target`, and `pose.fov` too when `size` is given. Put it after the stages
 * that place and aim the camera. The focus reaches a lens through {@link focusOutput}.
 */
export class FocusTracker {
  /** What stays in focus; change it at any time. */
  target: CameraTarget;
  /** The focus after the last update, in world units along the view. */
  focus = 0;
  /** The field of view after the last update, in degrees; 0 before the first update or without `size`. */
  fov = 0;
  private readonly focusRate: number;
  private readonly offset: number;
  private readonly minFocus: number;
  private readonly size?: number;
  private readonly share: number;
  private readonly fovRate: number;
  private readonly minFov: number;
  private readonly maxFov: number;
  private readonly point = new Float64Array(3);
  private started = false;
  /** @throws RangeError for a value outside what {@link FocusTrackerOptions} allows. */
  constructor(target: CameraTarget, options: FocusTrackerOptions = {}) {
    const {
      focusDamping = 6,
      focusOffset = 0,
      minFocus = 0.1,
      size,
      screenHeight = 0.5,
      fovDamping = 4,
      minFov = 10,
      maxFov = 100,
    } = options;
    if (!(focusDamping > 0 && focusDamping < Infinity) || !(fovDamping > 0 && fovDamping < Infinity))
      throw new RangeError('Invalid lens damping; pass a rate above 0');
    if (!Number.isFinite(focusOffset) || !(minFocus > 0 && minFocus < Infinity))
      throw new RangeError('Invalid lens focus; pass a finite focusOffset and a minFocus above 0');
    if (size !== undefined && !(size > 0 && size < Infinity))
      throw new RangeError('Invalid lens size; pass a subject height above 0');
    if (!(screenHeight > 0 && screenHeight <= 1))
      throw new RangeError('Invalid lens screenHeight; pass a share of the screen above 0 and at most 1');
    if (!(minFov > 0 && maxFov >= minFov && maxFov < 180))
      throw new RangeError('Invalid lens fov; pass a minFov above 0 and a maxFov at least as large, below 180');
    this.target = target;
    this.focusRate = focusDamping;
    this.offset = focusOffset;
    this.minFocus = minFocus;
    this.size = size;
    this.share = screenHeight;
    this.fovRate = fovDamping;
    this.minFov = minFov;
    this.maxFov = maxFov;
  }
  /** Forgets the focus: the next update is sharp on the subject at once, as on a cut. */
  reset(): void {
    this.started = false;
  }
  /** Stage hook. @throws RangeError for a bad target. */
  update(pose: CameraPose, delta: number): void {
    const { position, target } = pose,
      point = readTarget(this.target, this.point);
    let fx = target[0] - position[0],
      fy = target[1] - position[1],
      fz = target[2] - position[2];
    const length = Math.hypot(fx, fy, fz);
    if (!(length > 0)) return;
    fx /= length;
    fy /= length;
    fz /= length;
    const depth = (point[0] - position[0]) * fx + (point[1] - position[1]) * fy + (point[2] - position[2]) * fz,
      focusGoal = Math.max(this.minFocus, depth + this.offset),
      size = this.size;
    // Half the view at the subject's depth is depth tan(fov / 2), and the subject fills `share` of the whole.
    const fovGoal = size
      ? depth > 0
        ? Math.min(this.maxFov, Math.max(this.minFov, (Math.atan(size / (2 * this.share * depth)) * 360) / Math.PI))
        : this.maxFov
      : 0;
    if (this.started) {
      this.focus = focusGoal + (this.focus - focusGoal) * Math.exp(-this.focusRate * delta);
      this.fov = fovGoal + (this.fov - fovGoal) * Math.exp(-this.fovRate * delta);
    } else {
      this.focus = focusGoal;
      this.fov = fovGoal;
    }
    this.started = true;
    pose.focusDistance = this.focus;
    if (size) pose.fov = this.fov;
  }
}

/** Where {@link focusOutput} sends the focus. Each is optional and only touched when given. */
export interface FocusTargets {
  /** A `PhysicalCamera` from `@margoengine/cameras/physical`, or anything with `focusDistance`. */
  physical?: { focusDistance: number };
  /** A `DOF` effect from `@margoengine/dof`. */
  dof?: { options: { focalDistance?: number } };
}

/**
 * A stage for `brain.stages` that hands the pose's focus to a lens, so a blend racks focus from one camera to the next.
 * With no focus on the pose it leaves the lens alone.
 */
export const focusOutput =
  ({ physical, dof }: FocusTargets): CameraStage =>
  (pose) => {
    const focus = pose.focusDistance;
    if (!focus) return;
    if (physical) physical.focusDistance = focus;
    if (dof) dof.options.focalDistance = focus;
  };
