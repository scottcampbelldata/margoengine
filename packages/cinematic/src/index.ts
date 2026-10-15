/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import type { EngineKernel, Mesh, Vec3 } from '@margoengine/core';
import { engineRuntime, meshRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';

/**
 * Distance from `origin` along the unit `direction` to the first obstacle within `distance`, or null/undefined for none.
 * The arrays are reused every frame: read them, do not keep them.
 */
export type CameraCollision = (
  origin: Float64Array,
  direction: Float64Array,
  distance: number,
) => number | null | undefined;
/** Settings for {@link Cinematic}. Distances are world units. */
export interface CinematicOptions {
  /** Camera position relative to the target; finite and non-zero. Default [0, 3, 6]. */
  offset?: Vec3;
  /** Follow spring rate in 1/seconds (higher is stiffer); finite and > 0. Default 6. */
  damping?: number;
  /** Look-at spring rate in 1/seconds; finite and > 0. Default 8. */
  lookDamping?: number;
  /** Ground height at world `(x, z)`; the camera stays `clearance` above it along the arm. Must return finite values. */
  ground?: (x: number, z: number) => number;
  /** Space kept between the camera and the ground, and between the camera and a `collide` hit. Default 0.65. */
  clearance?: number;
  /**
   * Walls and ceilings: queried each frame along the arm from the look-at point to the camera. On a hit the camera moves
   * in at once to `clearance` short of it, and eases back out at the follow damping once the arm is clear. For example
   * `(o, d, max) => physics.shapeCast({shape: 'sphere', radius: 0.2}, [o[0], o[1], o[2]], [0, 0, 0, 1], [d[0], d[1], d[2]], {maxDistance: max, excludeDynamic: true})?.distance`.
   */
  collide?: CameraCollision;
}
const valid = (vector: ArrayLike<number>): void => {
  if (vector.length !== 3) throw new TypeError('Expected 3D target');
  for (let i = 0; i < 3; i++) if (!Number.isFinite(vector[i])) throw new RangeError('Target must be finite');
};

/** Critically damped virtual camera, with independent follow/look springs and additive shake. */
export class Cinematic implements EnginePlugin {
  readonly name = 'cinematic';
  /** Current camera offset from the target in world units; edit in place or with `setOrbitOffset`. */
  readonly offset: Float64Array;
  /** Smoothed camera position in world units, before shake. */
  readonly position = new Float64Array(3);
  /** Smoothed look-at point in world units. */
  readonly lookAt = new Float64Array(3);
  private readonly velocity = new Float64Array(6);
  private readonly target = new Float64Array(3);
  private readonly cameraPosition = new Float32Array(3);
  private readonly cameraTarget = new Float32Array(3);
  private readonly armDirection = new Float64Array(3);
  /** Arm length allowed by the last `collide` hit, easing back out; Infinity when unobstructed. */
  private reach = Infinity;
  private engine?: Engine;
  private mesh?: Mesh;
  private amplitude = 0;
  private remaining = 0;
  private shakeDuration = 1;
  private frequency = 25;
  private time = 0;
  private initialized = false;
  /**
   * @throws TypeError when `offset` is not 3 values or `collide` is not a function.
   * @throws RangeError for a non-finite or zero offset, invalid damping, a non-function `ground`, or invalid clearance.
   */
  constructor(readonly options: CinematicOptions = {}) {
    const offset = options.offset ?? [0, 3, 6];
    valid(offset);
    if (
      !Number.isFinite(options.damping ?? 6) ||
      (options.damping ?? 6) <= 0 ||
      !Number.isFinite(options.lookDamping ?? 8) ||
      (options.lookDamping ?? 8) <= 0
    )
      throw new RangeError('Invalid camera damping');
    if (!Math.hypot(offset[0], offset[1], offset[2])) throw new RangeError('Camera offset cannot be zero');
    this.validateGround();
    this.offset = new Float64Array(offset);
  }
  /** Create a rig and add it to `engine` as the 'cinematic' plugin; it then updates before every frame. */
  static attach(engine: EngineKernel, options: CinematicOptions = {}): Cinematic {
    const rig = new Cinematic(options);
    engineRuntime(engine).use(rig);
    return rig;
  }
  /**
   * Set `offset` from spherical coordinates: `yaw`/`pitch` in radians, `distance` (> 0) and extra `height` (default 0)
   * in world units.
   * @throws RangeError for non-finite values or a non-positive distance.
   */
  setOrbitOffset(yaw: number, pitch: number, distance: number, height = 0): void {
    if (
      !Number.isFinite(yaw) ||
      !Number.isFinite(pitch) ||
      !Number.isFinite(distance) ||
      distance <= 0 ||
      !Number.isFinite(height)
    )
      throw new RangeError('Invalid camera orbit');
    this.offset[0] = Math.sin(yaw) * Math.cos(pitch) * distance;
    this.offset[1] = Math.sin(pitch) * distance + height;
    this.offset[2] = Math.cos(yaw) * Math.cos(pitch) * distance;
  }
  /**
   * Follow a mesh (its world position, read each update) or a fixed world point.
   * @throws TypeError for a point that is not 3 values or a mesh of another engine.
   * @throws RangeError for a non-finite point.
   * @throws Error 'Mesh disposed' for a disposed mesh.
   */
  follow(target: Mesh | Vec3): void {
    if (Array.isArray(target)) {
      valid(target);
      this.target.set(target);
      this.mesh = undefined;
    } else {
      const mesh = meshRuntime(target as Mesh);
      mesh.check();
      if (this.engine && mesh.engine !== this.engine) throw new TypeError('Target belongs to another engine');
      this.mesh = target as Mesh;
    }
  }
  /**
   * Start a shake that fades out quadratically, replacing any running one.
   * @param amplitude World units, >= 0.
   * @param duration Seconds, > 0.
   * @param frequency Oscillation rate in radians per second, > 0. Default 25.
   * @throws RangeError for an out-of-range argument.
   */
  shake(amplitude: number, duration: number, frequency = 25): void {
    if (
      !Number.isFinite(amplitude) ||
      amplitude < 0 ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      !Number.isFinite(frequency) ||
      frequency <= 0
    )
      throw new RangeError('Invalid camera shake');
    this.amplitude = amplitude;
    this.remaining = this.shakeDuration = duration;
    this.frequency = frequency;
  }
  /**
   * Step the springs, shake, ground and wall avoidance by `delta` seconds and write the engine camera when attached.
   * Called automatically when attached as a plugin.
   * @throws RangeError for a negative or non-finite delta, invalid options, or non-finite ground or collision results.
   */
  update(delta: number): void {
    if (!Number.isFinite(delta) || delta < 0) throw new RangeError('Invalid camera delta');
    valid(this.offset);
    this.validateGround();
    const follow = this.options.damping ?? 6,
      look = this.options.lookDamping ?? 8;
    if (!Number.isFinite(follow) || follow <= 0 || !Number.isFinite(look) || look <= 0)
      throw new RangeError('Invalid camera damping');
    if (this.mesh) {
      const mesh = meshRuntime(this.mesh);
      mesh.check();
      mesh.engine.store.tick(false);
      this.target[0] = mesh.matrix[12];
      this.target[1] = mesh.matrix[13];
      this.target[2] = mesh.matrix[14];
    }
    const offsetY = this.groundOffset(this.target, this.offset[0], this.offset[1], this.offset[2]),
      followDecay = Math.exp(-follow * delta),
      lookDecay = Math.exp(-look * delta);
    for (let i = 0; i < 3; i++) {
      const offset = i === 1 ? offsetY : this.offset[i];
      if (!this.initialized) {
        this.position[i] = this.target[i] + offset;
        this.lookAt[i] = this.target[i];
      }
      for (let kind = 0; kind < 2; kind++) {
        const values = kind ? this.lookAt : this.position,
          goal = this.target[i] + (kind ? 0 : offset),
          omega = kind ? look : follow,
          j = kind * 3 + i;
        const error = values[i] - goal,
          derivative = this.velocity[j] + omega * error,
          decay = kind ? lookDecay : followDecay;
        values[i] = goal + (error + derivative * delta) * decay;
        this.velocity[j] = (this.velocity[j] - omega * derivative * delta) * decay;
      }
    }
    this.initialized = true;
    this.time += delta;
    this.remaining = Math.max(0, this.remaining - delta);
    const shake = this.amplitude * (this.remaining / this.shakeDuration) ** 2;
    for (let i = 0; i < 3; i++) {
      this.cameraPosition[i] = this.position[i] + Math.sin(this.time * this.frequency * (1 + i * 0.37) + i * 2) * shake;
      this.cameraTarget[i] = this.lookAt[i];
    }
    const dy = this.cameraPosition[1] - this.lookAt[1];
    const lift =
      this.groundOffset(
        this.lookAt,
        this.cameraPosition[0] - this.lookAt[0],
        dy,
        this.cameraPosition[2] - this.lookAt[2],
      ) - dy;
    if (lift > 0) {
      this.cameraPosition[1] += lift;
      this.position[1] += lift;
      this.velocity[1] = Math.max(0, this.velocity[1]);
    }
    // Preserve upward look when terrain clearance lifts a requested below-target orbit.
    if (this.options.ground && this.offset[1] < 0)
      this.cameraTarget[1] += Math.max(0, this.cameraPosition[1] - this.lookAt[1] - this.offset[1]);
    this.avoidWalls(followDecay);
    if (this.engine) {
      this.engine.camera.position = this.cameraPosition as unknown as Vec3;
      this.engine.camera.target = this.cameraTarget as unknown as Vec3;
    }
  }
  /** Shortens the rendered arm (look-at point to camera) to stay `clearance` in front of the first `collide` hit. */
  private avoidWalls(followDecay: number): void {
    const collide = this.options.collide;
    if (!collide) return;
    const o = this.lookAt,
      c = this.cameraPosition,
      d = this.armDirection;
    d[0] = c[0] - o[0];
    d[1] = c[1] - o[1];
    d[2] = c[2] - o[2];
    const length = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
    if (!(length > 0)) return;
    d[0] /= length;
    d[1] /= length;
    d[2] /= length;
    const hit = collide(o, d, length);
    if (hit !== null && hit !== undefined && (typeof hit !== 'number' || !Number.isFinite(hit)))
      throw new RangeError('Camera collision distance must be finite');
    const limit =
      hit === null || hit === undefined || hit >= length ? length : Math.max(0, hit - (this.options.clearance ?? 0.65));
    // In at once (never show the far side of a wall), out at the follow rate.
    this.reach = limit <= this.reach ? limit : this.reach + (limit - this.reach) * (1 - followDecay);
    if (limit === length && length - this.reach < 1e-4) this.reach = Infinity;
    if (this.reach < length) for (let i = 0; i < 3; i++) c[i] = o[i] + d[i] * this.reach;
  }
  private validateGround(): void {
    if (this.options.collide !== undefined && typeof this.options.collide !== 'function')
      throw new TypeError('Camera collide must be a function');
    if (
      (this.options.ground !== undefined && typeof this.options.ground !== 'function') ||
      !Number.isFinite(this.options.clearance ?? 0.65) ||
      (this.options.clearance ?? 0.65) < 0
    )
      throw new RangeError('Invalid camera ground clearance');
  }
  private groundOffset(origin: ArrayLike<number>, dx: number, dy: number, dz: number): number {
    const ground = this.options.ground;
    if (ground) {
      // shortcut: six samples can miss narrow ridges; use collision geometry for detailed obstacles.
      for (let i = 1; i <= 6; i++) {
        const t = i / 6,
          height = ground(origin[0] + dx * t, origin[2] + dz * t);
        if (!Number.isFinite(height)) throw new RangeError('Camera ground height must be finite');
        dy = Math.max(dy, (height + (this.options.clearance ?? 0.65) - origin[1]) / t);
      }
    }
    return dy;
  }
  /**
   * Plugin hook: bind the rig to `engine`.
   * @throws MargoError `'attached'` when already attached.
   * @throws TypeError when the followed mesh belongs to another engine.
   */
  setup(engine: Engine): void {
    if (this.engine)
      throw new MargoError(
        'attached',
        'Camera rig already attached; dispose() it before attaching it again, or create another rig',
      );
    if (this.mesh && meshRuntime(this.mesh).engine !== engine) throw new TypeError('Target belongs to another engine');
    this.engine = engine;
  }
  /** Plugin hook: runs {@link Cinematic.update} with the frame delta in seconds. */
  onPreUpdate(delta: number): void {
    this.update(delta);
  }
  /** Detach from the engine (removing the plugin) and stop following; the rig can be attached again. */
  dispose(): void {
    const engine = this.engine;
    this.engine = undefined;
    this.mesh = undefined;
    engine?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
