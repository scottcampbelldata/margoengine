import { Quaternion } from '@margoengine/math/quaternion';
import type { Spline } from '@margoengine/splines';
import { newFrame, SplineFrames, type SplineFrame, type SplineFramesOptions } from '@margoengine/splines/frames';
import { frameBasis, type ForwardAxis } from '@margoengine/splines/mesh';
import type { Tween, TweenOptions } from './index.js';

/** The local axis that faces along the path. `'z'` is a glTF model; `'-z'` is a camera, which looks down its -z. */
export type MotionForward = ForwardAxis | '-x' | '-y' | '-z';

/** Options for {@link MotionPath}. */
export interface MotionPathOptions {
  /** Local axis that points along the path. Default 'z'. */
  forward?: MotionForward;
  /** Options of the frames, or ready frames: `up`, `roll`, `samples`. Default {@link SplineFrames}' defaults. */
  frames?: SplineFrames | SplineFramesOptions;
}

/** Where an object stands on a path. */
export interface MotionPose {
  /** World position. */
  position: [number, number, number];
  /** Rotation `[x, y, z, w]` that turns the forward axis along the path. */
  quaternion: [number, number, number, number];
  /** Arc-length position, in world units from the start of the path. */
  distance: number;
}

/** What {@link motionPath} moves: a Mesh, or anything with these methods. */
export interface PathFollower {
  setPosition(value: [number, number, number]): unknown;
  setQuaternion(value: readonly number[]): unknown;
}

/** Options for {@link motionPath}: the timing of a tween, by `duration` or by `speed`. */
export interface MotionTweenOptions extends Omit<TweenOptions, 'duration'>, MotionPathOptions {
  /** Seconds to go from `start` to `end`, finite and >= 0. Give this or `speed`. */
  duration?: number;
  /** World units per second, above 0: the duration then follows from the length. Give this or `duration`. */
  speed?: number;
  /** Arc-length position to start from. Default 0. */
  start?: number;
  /** Arc-length position to stop at; below `start` runs the path backwards. Default the path length. */
  end?: number;
  /** Turn the object to face along the path. False moves it and leaves its rotation alone. Default true. */
  orient?: boolean;
}

/** Poses along a spline by arc length, so equal steps of distance are equal steps along the curve. */
export class MotionPath {
  /** Length of the path in world units. */
  readonly length: number;
  readonly frames: SplineFrames;
  private readonly axis: ForwardAxis;
  private readonly flip: boolean;
  private readonly frame: SplineFrame = newFrame();
  private readonly basis = new Float64Array(9);
  private readonly matrix = { elements: new Float64Array(16) };
  private readonly rotation = new Quaternion();
  /** @throws RangeError for a path with no length or an unknown axis. */
  constructor(
    readonly spline: Spline,
    { forward = 'z', frames }: MotionPathOptions = {},
  ) {
    if (!(spline.length > 0)) throw new RangeError('A motion path needs a spline with some length');
    if (!/^-?[xyz]$/.test(forward)) throw new RangeError("forward must be 'x', 'y', 'z', '-x', '-y' or '-z'");
    this.length = spline.length;
    this.frames = frames instanceof SplineFrames ? frames : new SplineFrames(spline, frames);
    this.flip = forward[0] === '-';
    this.axis = forward.at(-1) as ForwardAxis;
    this.matrix.elements[15] = 1;
  }
  /**
   * The pose at an arc-length position, written into `out`.
   * @throws RangeError when `distance` is outside 0 to the path length.
   */
  poseAt(
    distance: number,
    out: MotionPose = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], distance: 0 },
  ): MotionPose {
    const frame = this.frames.frameAt(distance, this.frame),
      basis = frameBasis(frame, this.axis, this.basis),
      m = this.matrix.elements;
    // Facing backwards is a half turn about up: the forward column and the third column change sign.
    const up = this.axis === 'y' ? 2 : 1;
    for (let column = 0; column < 3; column++) {
      const sign = this.flip && column !== up ? -1 : 1;
      for (let row = 0; row < 3; row++) m[column * 4 + row] = sign * basis[column * 3 + row];
    }
    const q = this.rotation.setFromRotationMatrix(this.matrix);
    out.position[0] = frame.position[0];
    out.position[1] = frame.position[1];
    out.position[2] = frame.position[2];
    out.quaternion[0] = q.x;
    out.quaternion[1] = q.y;
    out.quaternion[2] = q.z;
    out.quaternion[3] = q.w;
    out.distance = distance;
    return out;
  }
}

/**
 * Move `target` along a spline at even speed, turning it to face along the way. `easing` then shapes that speed; the
 * default stays even. A function target gets the pose instead, for a camera or anything else; the pose object is reused.
 * Returns a function that cancels the tween. Moving back on a `yoyo` pass, the object keeps facing the path's direction.
 *
 * ```ts
 * motionPath(tween, mesh, new Spline(points), {speed: 2});
 * ```
 * @throws RangeError for bad timing, both or neither of `duration` and `speed`, or `start` or `end` off the path.
 */
export function motionPath(
  tween: Tween,
  target: PathFollower | ((pose: MotionPose) => void),
  path: Spline | MotionPath,
  options: MotionTweenOptions,
): () => void {
  const { forward, frames, duration, speed, start = 0, end, orient = true, ...timing } = options,
    motion = path instanceof MotionPath ? path : new MotionPath(path, { forward, frames }),
    last = end ?? motion.length;
  if ((duration === undefined) === (speed === undefined)) throw new RangeError('Give exactly one of duration or speed');
  if (speed !== undefined && !(speed > 0 && Number.isFinite(speed)))
    throw new RangeError('Motion speed must be finite and above 0');
  if (![start, last].every((d) => Number.isFinite(d) && d >= 0 && d <= motion.length))
    throw new RangeError('start and end must be from 0 to the path length');
  const pose: MotionPose = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], distance: 0 },
    span = last - start,
    seconds = duration ?? Math.abs(span) / (speed as number);
  if (typeof target !== 'function' && typeof target?.setPosition !== 'function')
    throw new RangeError('A motion target needs setPosition and setQuaternion, or pass a function');
  return tween.custom(
    (progress) => {
      // An easing may overshoot 0..1; the path has no more length there, so the object waits at the end.
      motion.poseAt(Math.min(motion.length, Math.max(0, start + span * progress)), pose);
      if (typeof target === 'function') target(pose);
      else {
        target.setPosition(pose.position);
        if (orient) target.setQuaternion(pose.quaternion);
      }
    },
    { ...timing, duration: seconds },
  );
}
