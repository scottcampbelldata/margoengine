import type { Camera } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { cross, dot, normalize, sub } from '@margoengine/math/vec3';
import { interpolateQuaternions, rotateByQuaternion, rotationToQuaternion } from '@margoengine/math/quat';
import type { Controls } from './controls.js';
import { OrbitControls as Orbit, MapControls as Map } from './orbit.js';
import { ArcballControls as Arcball } from './arcball.js';
import { TrackballControls as Trackball } from './trackball.js';
import type { V3 } from './math.js';
import type { KeyAction } from './profiles.js';

/** Transition timing in seconds. Cancellation resolves false; completion resolves true. */
export interface TransitionOptions {
  /** Default 0.6 seconds; zero applies immediately. */
  duration?: number;
  /** Default quintic smoothstep, with zero velocity and acceleration at both ends. Must return a finite value in [0, 1]. */
  easing?: (progress: number) => number;
  /** Cancels at the current view; an already aborted signal leaves the view unchanged. */
  signal?: AbortSignal;
  /** Screen up at the destination for arcball and rolling trackball. Default current up. */
  up?: readonly [number, number, number];
}

/** Viewport framing options shared by box and sphere fits. */
export interface FitOptions extends TransitionOptions {
  /** Fraction of each viewport dimension left around the object, on each side. Default 0.05, range [0, 0.5). */
  padding?: number;
  /** Width divided by height. Default element aspect, or 1 without an element. */
  aspect?: number;
}

type Host = Controls & {
  minDistance: number;
  maxDistance: number;
  minPolarAngle?: number;
  maxPolarAngle?: number;
  minAzimuthAngle?: number;
  maxAzimuthAngle?: number;
  targetBounds?: { min: readonly number[]; max: readonly number[] } | null;
  minTargetRadius?: number;
  maxTargetRadius?: number;
  minZoom?: number;
  maxZoom?: number;
  projection?: { zoom: number } | null;
};
type Pose = { position: V3; target: V3; up: V3; distance: number; azimuth: number; polar: number; rotation: number[] };
type Motion = {
  from: Pose;
  to: Pose;
  elapsed: number;
  duration: number;
  easing: (t: number) => number;
  roll: boolean;
  zoom?: [number, number];
  projection?: { zoom: number };
  finish: (completed: boolean) => void;
};

const fail = (message: string): never => {
  throw new RangeError(`Camera transition: ${message}; pass a valid view and transition options`);
};
const vector = (v: readonly number[]): V3 => {
  if (v.length !== 3 || !v.every(Number.isFinite)) fail('use three finite coordinates');
  return [...v] as V3;
};
const smooth = (t: number): number => (t > 0.5 ? 1 - smooth(1 - t) : t * t * t * (10 + t * (-15 + t * 6)));
const mix = (a: readonly number[], b: readonly number[], t: number): V3 => a.map((v, i) => v + (b[i] - v) * t) as V3;
const snapshot = (camera: Pick<Camera, 'position' | 'target' | 'up'>): Pose => {
  const position = vector(camera.position),
    target = vector(camera.target),
    up = vector(camera.up);
  const eye = sub(position, target),
    distance = Math.hypot(...eye),
    side = cross(up, eye);
  if (!(distance > 0) || !Number.isFinite(distance) || !(Math.hypot(...side) / distance > 1e-12))
    fail('position must differ from target and up must not be parallel to the view');
  const back = normalize(eye),
    right = normalize(side),
    screenUp = cross(back, right);
  return {
    position,
    target,
    up,
    distance,
    azimuth: Math.atan2(eye[0], eye[2]),
    polar: Math.acos(Math.max(-1, Math.min(1, eye[1] / distance))),
    rotation: rotationToQuaternion([...right, ...screenUp, ...back]),
  };
};

/** Owned by a control imported from /transitions. Uses its existing update and disposal lifecycle. */
export class CameraTransitions {
  private motion: Motion | null = null;
  private disposed = false;
  private expected: number[] | null = null;
  private readonly interrupt = (): void => this.cancel();
  /** @internal Construct through the controls exported by this entry. */
  constructor(
    private readonly host: Host,
    private readonly stopPending: () => void,
    private readonly rolling: () => boolean,
  ) {
    host.addEventListener('start', this.interrupt);
  }
  get active(): boolean {
    return this.motion !== null;
  }

  /** Keeps the current view, settles the pending promise false, and removes its abort listener. */
  cancel(): void {
    const motion = this.motion;
    this.motion = null;
    this.expected = null;
    motion?.finish(false);
  }

  /** Move the eye and target together, orbiting around the interpolated target instead of crossing through it. */
  setLookAt(
    position: readonly [number, number, number],
    target: readonly [number, number, number],
    options: TransitionOptions = {},
  ): Promise<boolean> {
    return this.start(position, target, options);
  }
  /** Move only the look-at point; the final eye stays where it is when called. */
  setTarget(target: readonly [number, number, number], options: TransitionOptions = {}): Promise<boolean> {
    return this.start(this.host.camera.position, target, options);
  }

  private fitSettings(options: FitOptions): {
    fraction: number;
    aspect: number;
    tan: number;
    ortho: number | undefined;
  } {
    const padding = options.padding ?? 0.05;
    const aspect =
      options.aspect ?? (this.host.element ? this.host.element.clientWidth / this.host.element.clientHeight : 1);
    if (!(padding >= 0 && padding < 0.5) || !(aspect > 0) || !Number.isFinite(aspect))
      fail('invalid padding or aspect');
    const tan = Math.tan((this.host.camera.fov * Math.PI) / 360);
    if (!(tan > 0) || !Number.isFinite(tan)) fail('invalid camera field of view');
    const m = this.host.camera.matrix;
    const scale = m[15] && !m[3] && !m[7] && !m[11] ? Math.hypot(m[1], m[5], m[9]) : 0;
    if (this.host.camera.project && !scale)
      fail('update an orthographic camera matrix before fitting; custom perspective projections are unsupported');
    if (scale && !this.host.projection) fail('orthographic fitting needs a projection with a writable zoom');
    return { fraction: 1 - 2 * padding, aspect, tan, ortho: scale ? 1 / scale : undefined };
  }

  /** Fit all eight corners in the current view orientation, including their depth and the near plane. */
  fitToBox(
    box: { min: readonly [number, number, number]; max: readonly [number, number, number] },
    options: FitOptions = {},
  ): Promise<boolean> {
    const min = vector(box.min),
      max = vector(box.max);
    if (min.some((v, i) => v > max[i])) fail('box min must not exceed max');
    const centre = mix(min, max, 0.5),
      { fraction, aspect, tan, ortho } = this.fitSettings(options);
    const frame = this.frame(options.up),
      back = frame.back;
    let distance = this.host.camera.near,
      halfHeight = 0,
      farDepth = -Infinity;
    for (let i = 0; i < 8; i++) {
      const offset = sub([i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]], centre);
      const x = Math.abs(dot(offset, frame.right)),
        y = Math.abs(dot(offset, frame.up)),
        z = dot(offset, back);
      const half = Math.max(x / aspect, y) / fraction;
      halfHeight = Math.max(halfHeight, half);
      distance = Math.max(distance, z + this.host.camera.near, ortho ? 0 : z + half / tan);
      farDepth = Math.max(farDepth, -z);
    }
    if (ortho) distance = Math.max(distance, snapshot(this.host.camera).distance);
    distance = Math.max(distance, this.host.minDistance);
    if (distance + farDepth > this.host.camera.far) fail('box does not fit between camera near and far planes');
    return this.start(
      centre.map((v, i) => v + back[i] * distance) as V3,
      centre,
      options,
      ortho && halfHeight > 0 ? (this.host.projection!.zoom * ortho) / halfHeight : undefined,
    );
  }

  /** Fit the sphere silhouette, using the smaller horizontal/vertical field of view. */
  fitToSphere(
    sphere: { centre: readonly [number, number, number]; radius: number },
    options: FitOptions = {},
  ): Promise<boolean> {
    const centre = vector(sphere.centre),
      radius = sphere.radius;
    if (!(radius >= 0) || !Number.isFinite(radius)) fail('sphere radius must be finite and nonnegative');
    const { fraction, aspect, tan, ortho } = this.fitSettings(options),
      back = this.frame(options.up).back;
    const half = radius / (fraction * Math.min(1, aspect));
    let distance = ortho
      ? snapshot(this.host.camera).distance
      : radius / Math.sin(Math.atan(tan * fraction * Math.min(1, aspect)));
    distance = Math.max(distance, radius + this.host.camera.near, this.host.minDistance);
    if (distance + radius > this.host.camera.far) fail('sphere does not fit between camera near and far planes');
    return this.start(
      centre.map((v, i) => v + back[i] * distance) as V3,
      centre,
      options,
      ortho && half > 0 ? (this.host.projection!.zoom * ortho) / half : undefined,
    );
  }

  private frame(up?: readonly number[]): { back: V3; right: V3; up: V3 } {
    const camera = this.host.camera,
      back = normalize(sub(camera.position, camera.target));
    const right = normalize(cross(this.rolling() ? (up ?? camera.up) : [0, 1, 0], back));
    if (!(Math.hypot(...right) > 0)) fail('fit needs a nonparallel up vector');
    return { back, right, up: cross(back, right) };
  }

  private start(
    position: readonly number[],
    target: readonly number[],
    options: TransitionOptions,
    zoom?: number,
  ): Promise<boolean> {
    if (this.disposed) throw new MargoError('disposed', 'Camera transitions are disposed; create new controls from /transitions');
    const host = this.host,
      camera = host.camera,
      roll = this.rolling();
    const from = snapshot(camera),
      to = snapshot({
        position: vector(position),
        target: vector(target),
        up: roll ? options.up ?? camera.up : [0, 1, 0],
      });
    const duration = options.duration ?? 0.6;
    if (!(duration >= 0) || !Number.isFinite(duration)) fail('duration must be finite and nonnegative');
    if (to.distance < host.minDistance || to.distance > host.maxDistance)
      fail('destination exceeds the control distance limits');
    if (!roll) {
      const lo = Math.max(1e-6, host.minPolarAngle ?? 0),
        hi = Math.min(Math.PI - 1e-6, host.maxPolarAngle ?? Math.PI);
      if (to.polar < lo || to.polar > hi) fail('destination exceeds the control polar limits');
      const azLo = host.minAzimuthAngle ?? -Infinity,
        azHi = host.maxAzimuthAngle ?? Infinity;
      if (Number.isFinite(azLo) && Number.isFinite(azHi)) {
        const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
        const lo = wrap(azLo),
          rawHi = wrap(azHi),
          hi = rawHi < lo ? rawHi + 2 * Math.PI : rawHi;
        const lift = (a: number): number => (a < lo ? a + 2 * Math.PI : a);
        from.azimuth = lift(from.azimuth);
        to.azimuth = lift(to.azimuth);
        if (to.azimuth > hi || from.azimuth > hi)
          fail('destination or current view exceeds the control azimuth limits');
      } else {
        to.azimuth =
          from.azimuth + Math.atan2(Math.sin(to.azimuth - from.azimuth), Math.cos(to.azimuth - from.azimuth));
      }
    }
    if (host.targetBounds && to.target.some((v, i) => v < host.targetBounds!.min[i] || v > host.targetBounds!.max[i]))
      fail('destination exceeds the control target bounds');
    if (host instanceof Orbit) {
      const targetRadius = Math.hypot(...sub(to.target, host.cursor));
      if (targetRadius < host.minTargetRadius || targetRadius > host.maxTargetRadius)
        fail('destination exceeds the target radius limits');
      const segment = sub(to.target, from.target),
        length2 = dot(segment, segment);
      const closest = length2 ? Math.max(0, Math.min(1, -dot(sub(from.target, host.cursor), segment) / length2)) : 0;
      if (Math.hypot(...sub(mix(from.target, to.target, closest), host.cursor)) < host.minTargetRadius)
        fail('target path crosses the control minimum target radius; choose an intermediate target');
    }
    if (
      zoom !== undefined &&
      (!(zoom > 0) || !Number.isFinite(zoom) || zoom < (host.minZoom ?? 0) || zoom > (host.maxZoom ?? Infinity))
    )
      fail('fit exceeds the control zoom limits');
    if (options.signal?.aborted) return Promise.resolve(false);
    this.cancel();
    this.stopPending();
    return new Promise((resolve) => {
      const signal = options.signal,
        abort = (): void => this.cancel();
      this.motion = {
        from,
        to,
        elapsed: 0,
        duration,
        easing: options.easing ?? smooth,
        roll,
        zoom: zoom === undefined ? undefined : [host.projection!.zoom, zoom],
        projection: host.projection ?? undefined,
        finish(completed) {
          signal?.removeEventListener('abort', abort);
          resolve(completed);
        },
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.remember();
      if (!duration) this.update(0);
    });
  }

  /** @internal Advanced by the owning control, before rendering. */
  update(delta: number): boolean {
    if (!(delta >= 0) || !Number.isFinite(delta)) fail('delta must be finite and nonnegative');
    const motion = this.motion;
    if (!motion) return false;
    const camera = this.host.camera;
    if (
      [...camera.position, ...camera.target, ...camera.up, motion.projection?.zoom ?? 1].some(
        (v, i) => v !== this.expected![i],
      )
    ) {
      this.cancel();
      return false;
    }
    if (!delta && motion.duration) return false;
    motion.elapsed = Math.min(motion.duration, motion.elapsed + delta);
    const progress = motion.duration ? motion.elapsed / motion.duration : 1;
    let t: number;
    try {
      t = motion.easing(progress);
    } catch (error) {
      this.cancel();
      throw error;
    }
    if (this.motion !== motion) return false;
    if (!(t >= 0 && t <= 1) || !Number.isFinite(t)) {
      this.cancel();
      fail('easing must return a finite value in [0, 1]');
    }
    const { from, to } = motion;
    let back: V3, up: V3;
    if (motion.roll) {
      const q = interpolateQuaternions(from.rotation, to.rotation, t, 0.9995);
      back = rotateByQuaternion([0, 0, 1], q);
      up = rotateByQuaternion([0, 1, 0], q);
    } else {
      const azimuth = from.azimuth + (to.azimuth - from.azimuth) * t,
        polar = from.polar + (to.polar - from.polar) * t;
      back = [Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), Math.sin(polar) * Math.cos(azimuth)];
      up = [0, 1, 0];
    }
    const target = mix(from.target, to.target, t),
      distance = Math.exp(Math.log(from.distance) * (1 - t) + Math.log(to.distance) * t);
    camera.target = progress === 1 ? [...to.target] : target;
    camera.position = progress === 1 ? [...to.position] : (target.map((v, i) => v + back[i] * distance) as V3);
    camera.up = progress === 1 ? [...to.up] : up;
    if (motion.zoom)
      motion.projection!.zoom =
        progress === 1 ? motion.zoom[1] : Math.exp(Math.log(motion.zoom[0]) * (1 - t) + Math.log(motion.zoom[1]) * t);
    this.remember();
    if (progress === 1) {
      this.motion = null;
      this.expected = null;
      motion.finish(true);
    }
    this.host.dispatchEvent({ type: 'change' });
    return true;
  }
  private remember(): void {
    const camera = this.host.camera;
    this.expected = [...camera.position, ...camera.target, ...camera.up, this.host.projection?.zoom ?? 1];
  }
  /** @internal The owning control disposes this before its input and engine registration. */
  dispose(): void {
    this.cancel();
    this.disposed = true;
    this.host.removeEventListener('start', this.interrupt);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/** Orbit controls with interruptible programmatic moves on `transitions`. */
export class OrbitControls extends Orbit {
  protected override applyNow(): void {
    this.transitions?.cancel();
    super.applyNow();
  }
  protected override keyAction(action: KeyAction): void {
    this.transitions?.cancel();
    super.keyAction(action);
  }
  readonly transitions = new CameraTransitions(
    this,
    () => this.clearPending(),
    () => false,
  );
  override update(delta = 1 / 60): boolean {
    return this.transitions?.active ? this.transitions.update(delta) : super.update(delta);
  }
  override reset(): void {
    this.transitions?.cancel();
    super.reset();
  }
  override dispose(): void {
    this.transitions?.dispose();
    super.dispose();
  }
}
/** Map controls with interruptible programmatic moves on `transitions`. */
export class MapControls extends Map {
  protected override applyNow(): void {
    this.transitions?.cancel();
    super.applyNow();
  }
  protected override keyAction(action: KeyAction): void {
    this.transitions?.cancel();
    super.keyAction(action);
  }
  readonly transitions = new CameraTransitions(
    this,
    () => this.clearPending(),
    () => false,
  );
  override update(delta = 1 / 60): boolean {
    return this.transitions?.active ? this.transitions.update(delta) : super.update(delta);
  }
  override reset(): void {
    this.transitions?.cancel();
    super.reset();
  }
  override dispose(): void {
    this.transitions?.dispose();
    super.dispose();
  }
}
/** Arcball controls with roll-preserving quaternion transitions. */
export class ArcballControls extends Arcball {
  protected override applyNow(): void {
    this.transitions?.cancel();
    super.applyNow();
  }
  readonly transitions = new CameraTransitions(
    this,
    () => this.clearPending(),
    () => true,
  );
  override update(delta = 1 / 60): boolean {
    return this.transitions?.active ? this.transitions.update(delta) : super.update(delta);
  }
  override reset(): void {
    this.transitions?.cancel();
    super.reset();
  }
  override dispose(): void {
    this.transitions?.dispose();
    super.dispose();
  }
}
/** Trackball controls with transitions matching the current `enableRoll` setting. */
export class TrackballControls extends Trackball {
  /** Optional orthographic projection used for fitting. Default null. */
  projection: { zoom: number } | null = null;
  readonly transitions = new CameraTransitions(
    this,
    () => this.clearPending(),
    () => this.enableRoll,
  );
  override update(delta = 1 / 60): boolean {
    return this.transitions?.active ? this.transitions.update(delta) : super.update(delta);
  }
  override reset(): void {
    this.transitions?.cancel();
    super.reset();
  }
  override dispose(): void {
    this.transitions?.dispose();
    super.dispose();
  }
}
