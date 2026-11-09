/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/cinematic/brain: many virtual cameras, one real one. Every enabled camera keeps running, the brain shows
// the one with the highest priority and blends when that changes. A blend is a stack of live cameras, so a switch in the
// middle of a blend starts from what is on screen and nothing freezes while it runs.
import type { EngineKernel, Vec3 } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';

/** Where a camera stands and what it sees. Stages edit one in place. All distances are world units. */
export interface CameraPose {
  /** Camera position. */
  readonly position: Float64Array;
  /** The point looked at. */
  readonly target: Float64Array;
  /** World up: the direction the top of the screen leans to. It need not be unit length. Default [0, 1, 0]. */
  readonly up: Float64Array;
  /** Vertical field of view in degrees, above 0 and below 180. Default 60. */
  fov: number;
  /** Turn about the view direction in radians. Default 0. */
  roll: number;
  /** Distance to the plane of focus; 0 means no stage has set one. Default 0. */
  focusDistance: number;
}

/** What a stage knows about the view it works for. */
export interface StageContext {
  /** Width / height of the view. */
  readonly aspect: number;
}

/**
 * One step of a camera's work: a function, or an object with `update` and an optional `reset`. A stage changes `pose`
 * in place and keeps what it needs between frames; `reset` forgets that, as after a teleport.
 */
export type CameraStage =
  | ((pose: CameraPose, delta: number, context: StageContext) => void)
  | {
      update(pose: CameraPose, delta: number, context: StageContext): void;
      reset?(): void;
    };

/** Settings of a {@link VirtualCamera}. */
export interface VirtualCameraOptions {
  /** Names the camera in blend rules and events. Names in one brain differ. Default none. */
  name?: string;
  /** The highest priority among enabled cameras goes on screen. Any finite number. Default 0. */
  priority?: number;
  /** Where the camera stands before its stages run. Default [0, 2, 5]. */
  position?: Vec3;
  /** What it looks at before its stages run. Default [0, 0, 0]. */
  target?: Vec3;
  /** World up. Default [0, 1, 0]. */
  up?: Vec3;
  /** Vertical field of view in degrees. Default 60. */
  fov?: number;
  /** Radians. Default 0. */
  roll?: number;
  /** Run in order every update. Default none. */
  stages?: readonly CameraStage[];
}

/** How one camera takes over from another. */
export interface CameraBlend {
  /** Seconds, 0 or more; 0 is a cut. */
  duration: number;
  /** Shape of the blend: takes 0..1, gives 0..1, values outside are clamped. Any tween easing fits. Default smoothstep. */
  ease?: (u: number) => number;
  /**
   * `'direct'` (default) moves the camera straight across and turns the view. `'orbit'` swings it around the point
   * looked at, for two cameras on one subject, so the move does not cut through the subject.
   */
  style?: 'direct' | 'orbit';
}

/** A {@link CameraBlend} for one pair of cameras. `'*'` matches any camera. */
export interface CameraBlendRule extends CameraBlend {
  from: string;
  to: string;
}

/** Settings of a {@link CameraBrain}. */
export interface CameraBrainOptions {
  /** Used when no rule matches. Default a 1 second smoothstep, direct. */
  blend?: CameraBlend;
  /** The first rule for the exact pair wins, then `from` to `'*'`, then `'*'` to `to`, then `'*'` to `'*'`. Default none. */
  rules?: readonly CameraBlendRule[];
  /** Plugin name, so several brains can share an engine (one per view). Default 'cinematic-brain'. */
  name?: string;
  /** The camera written. Default `engine.camera`. */
  camera?: { position: Vec3; target: Vec3; up: Vec3; fov: number };
  /** Width / height of the view. Default the canvas's when attached, otherwise 16 / 9. */
  aspect?: number;
}

/** What `change` and `blended` give to a listener. */
export interface CameraBrainEvent {
  /** The camera on screen before the change; null for the first camera. */
  from: VirtualCamera | null;
  /** The camera taking over. */
  to: VirtualCamera;
  /** Seconds the blend takes; 0 for a cut. */
  duration: number;
}

const finite3 = (value: ArrayLike<number>, what: string): void => {
  if (value.length !== 3 || !(Number.isFinite(value[0]) && Number.isFinite(value[1]) && Number.isFinite(value[2])))
    throw new RangeError(`Invalid ${what}; pass three finite numbers`);
};
const checkFov = (fov: number): void => {
  if (!(fov > 0 && fov < 180)) throw new RangeError('Invalid camera fov; pass degrees above 0 and below 180');
};
const checkDelta = (delta: number): void => {
  if (!Number.isFinite(delta) || delta < 0)
    throw new RangeError('Invalid camera delta; pass a finite delta of 0 or more seconds');
};
const checkAspect = (aspect: number): void => {
  if (!(aspect > 0 && aspect < Infinity)) throw new RangeError('Invalid camera aspect; pass a width / height above 0');
};
const smoothstep = (u: number): number => u * u * (3 - 2 * u);
const checkBlend = (blend: CameraBlend): void => {
  if (
    !Number.isFinite(blend.duration) ||
    blend.duration < 0 ||
    (blend.ease !== undefined && typeof blend.ease !== 'function') ||
    (blend.style !== undefined && blend.style !== 'direct' && blend.style !== 'orbit')
  )
    throw new RangeError(
      "Invalid camera blend; pass a duration of 0 or more, an ease function and style 'direct' or 'orbit'",
    );
};

/** A pose with the defaults of {@link VirtualCameraOptions}, or the values given. */
export function createPose({
  position = [0, 2, 5],
  target = [0, 0, 0],
  up = [0, 1, 0],
  fov = 60,
  roll = 0,
}: Pick<VirtualCameraOptions, 'position' | 'target' | 'up' | 'fov' | 'roll'> = {}): CameraPose {
  finite3(position, 'camera position');
  finite3(target, 'camera target');
  finite3(up, 'camera up');
  checkFov(fov);
  if (!Number.isFinite(roll)) throw new RangeError('Invalid camera roll; pass finite radians');
  return {
    position: new Float64Array(position),
    target: new Float64Array(target),
    up: new Float64Array(up),
    fov,
    roll,
    focusDistance: 0,
  };
}

/** Copies every field of `from` into `to`. */
export function copyPose(to: CameraPose, from: CameraPose): CameraPose {
  to.position.set(from.position);
  to.target.set(from.target);
  to.up.set(from.up);
  to.fov = from.fov;
  to.roll = from.roll;
  to.focusDistance = from.focusDistance;
  return to;
}

const runStage = (stage: CameraStage, pose: CameraPose, delta: number, context: StageContext): void => {
  if (typeof stage === 'function') stage(pose, delta, context);
  else stage.update(pose, delta, context);
};

/**
 * A camera that is not the real one: a base pose, a priority and a list of stages. Use it alone with `update`, or give
 * it to a {@link CameraBrain}.
 */
export class VirtualCamera {
  readonly name?: string;
  /** The highest priority among enabled cameras goes on screen; change it at any time. */
  priority: number;
  /** Where the camera starts each update, before its stages. Edit it in place. */
  readonly base: CameraPose;
  /** The result of the last update. */
  readonly pose: CameraPose;
  /** Run in order every update. */
  readonly stages: CameraStage[];
  private active = true;
  private stale = false;
  private readonly context = { aspect: 16 / 9 };
  /** @throws RangeError for a value outside what {@link VirtualCameraOptions} allows. */
  constructor(options: VirtualCameraOptions = {}) {
    const { name, priority = 0, stages = [] } = options;
    if (!Number.isFinite(priority)) throw new RangeError('Invalid camera priority; pass a finite number');
    this.name = name;
    this.priority = priority;
    this.base = createPose(options);
    this.pose = copyPose(createPose(), this.base);
    this.stages = [...stages];
  }
  /** A disabled camera never goes on screen and stops updating; when enabled again its stages start fresh. */
  get enabled(): boolean {
    return this.active;
  }
  set enabled(value: boolean) {
    if (value && !this.active) this.stale = true;
    this.active = value;
  }
  /** Tells every stage to forget what it kept, as after a teleport. */
  reset(): void {
    this.stale = false;
    for (const stage of this.stages) if (typeof stage !== 'function') stage.reset?.();
  }
  /**
   * Runs the stages from the base pose into `pose`. A brain calls this each frame.
   * @param delta Seconds, 0 or more.
   * @param aspect Width / height of the view. Default 16 / 9.
   * @throws RangeError for a bad delta or aspect, or a stage's own error.
   */
  update(delta: number, aspect = 16 / 9): CameraPose {
    checkDelta(delta);
    checkAspect(aspect);
    if (this.stale) this.reset();
    this.context.aspect = aspect;
    copyPose(this.pose, this.base);
    for (const stage of this.stages) runStage(stage, this.pose, delta, this.context);
    return this.pose;
  }
}

/** Turns a `Cinematic` rig into a stage: the rig runs unattached and places the camera. Give it no engine of its own. */
export const rigStage =
  (rig: {
    update(delta: number): void;
    readonly cameraPosition: ArrayLike<number>;
    readonly cameraTarget: ArrayLike<number>;
  }): CameraStage =>
  (pose, delta) => {
    rig.update(delta);
    pose.position.set(rig.cameraPosition);
    pose.target.set(rig.cameraTarget);
  };

/**
 * Turns `from` toward `to` by `u` and writes the result to `out`, which may be either. Lengths mix, directions turn on
 * the shortest arc, and opposite directions turn about `up` so a blend across 180 degrees pans instead of flipping.
 */
function swing(out: Float64Array, from: Float64Array, to: Float64Array, u: number, up: Float64Array): void {
  const la = Math.hypot(from[0], from[1], from[2]),
    lb = Math.hypot(to[0], to[1], to[2]);
  if (!(la > 0 && lb > 0)) {
    for (let i = 0; i < 3; i++) out[i] = from[i] + (to[i] - from[i]) * u;
    return;
  }
  const ax = from[0] / la,
    ay = from[1] / la,
    az = from[2] / la,
    bx = to[0] / lb,
    by = to[1] / lb,
    bz = to[2] / lb,
    cosine = ax * bx + ay * by + az * bz,
    size = la + (lb - la) * u;
  // The unit vector in the plane of the turn, at a right angle to `from`.
  let px = bx - ax * cosine,
    py = by - ay * cosine,
    pz = bz - az * cosine,
    sine = Math.hypot(px, py, pz);
  if (sine < 1e-9) {
    if (cosine > 0) {
      out[0] = ax * size;
      out[1] = ay * size;
      out[2] = az * size;
      return;
    }
    px = ay * up[2] - az * up[1];
    py = az * up[0] - ax * up[2];
    pz = ax * up[1] - ay * up[0];
    if (Math.hypot(px, py, pz) < 1e-9) {
      // Straight along up as well: any right angle will do.
      const small = Math.abs(ax) < 0.9;
      px = small ? 0 : -az;
      py = small ? az : 0;
      pz = small ? -ay : ax;
    }
    sine = 0;
  }
  const side = Math.hypot(px, py, pz),
    angle = Math.atan2(sine, cosine) * u,
    c = Math.cos(angle) * size,
    s = (Math.sin(angle) * size) / side;
  out[0] = ax * c + px * s;
  out[1] = ay * c + py * s;
  out[2] = az * c + pz * s;
}

const armA = new Float64Array(3);
const armB = new Float64Array(3);
/**
 * Moves `out` toward `to` by `u`. At `u` 0 it stays, at 1 it is `to`, so a blend starts and ends without a step. The
 * scratch arrays hold nothing between calls.
 */
function blendPose(out: CameraPose, to: CameraPose, u: number, style: 'direct' | 'orbit'): void {
  if (u <= 0) return;
  if (u >= 1) {
    copyPose(out, to);
    return;
  }
  const orbit = style === 'orbit';
  for (let i = 0; i < 3; i++) {
    armA[i] = orbit ? out.position[i] - out.target[i] : out.target[i] - out.position[i];
    armB[i] = orbit ? to.position[i] - to.target[i] : to.target[i] - to.position[i];
    out.up[i] += (to.up[i] - out.up[i]) * u;
  }
  swing(armA, armA, armB, u, to.up);
  for (let i = 0; i < 3; i++)
    if (orbit) {
      out.target[i] += (to.target[i] - out.target[i]) * u;
      out.position[i] = out.target[i] + armA[i];
    } else {
      out.position[i] += (to.position[i] - out.position[i]) * u;
      out.target[i] = out.position[i] + armA[i];
    }
  out.fov += (to.fov - out.fov) * u;
  out.roll += (to.roll - out.roll) * u;
  // A camera with no focus takes the other's rather than racing from 0.
  if (!out.focusDistance) out.focusDistance = to.focusDistance;
  else if (to.focusDistance) out.focusDistance += (to.focusDistance - out.focusDistance) * u;
}

interface Layer {
  camera: VirtualCamera;
  elapsed: number;
  duration: number;
  ease: (u: number) => number;
  style: 'direct' | 'orbit';
}

type BrainListener = (event: CameraBrainEvent) => void;

/**
 * Shows one of many {@link VirtualCamera}s: the enabled camera with the highest priority. On a tie the camera on screen
 * stays, otherwise the one added last wins. A change blends by the rules, and every camera in a blend keeps moving. A
 * switch in the middle of a blend starts from what is on screen, so the picture never jumps.
 */
export class CameraBrain implements EnginePlugin {
  readonly name: string;
  /** The result of the last update. */
  readonly pose = createPose();
  /** Run in order on the blended pose, so they hold whichever cameras are on screen. */
  readonly stages: CameraStage[] = [];
  private readonly cameras: VirtualCamera[] = [];
  private readonly listeners = { change: new Set<BrainListener>(), blended: new Set<BrainListener>() };
  private layers: Layer[] = [];
  private blendFrom: VirtualCamera | null = null;
  private engine?: Engine;
  private readonly screenUp = new Float64Array([0, 1, 0]);
  private readonly outPosition: [number, number, number] = [0, 0, 0];
  private readonly outTarget: [number, number, number] = [0, 0, 0];
  private readonly outUp: [number, number, number] = [0, 1, 0];
  private readonly context = { aspect: 16 / 9 };
  /** @throws RangeError for a bad blend, rule, or aspect. */
  constructor(readonly options: CameraBrainOptions = {}) {
    this.name = options.name ?? 'cinematic-brain';
    if (options.blend) checkBlend(options.blend);
    for (const rule of options.rules ?? []) {
      checkBlend(rule);
      if (typeof rule.from !== 'string' || typeof rule.to !== 'string')
        throw new RangeError("Invalid camera blend rule; pass from and to as camera names or '*'");
    }
    if (options.aspect !== undefined) checkAspect(options.aspect);
  }
  /** Create a brain and add it to `engine`; it then updates before every frame and owns the camera. */
  static attach(engine: EngineKernel, options: CameraBrainOptions = {}): CameraBrain {
    const brain = new CameraBrain(options);
    engineRuntime(engine).use(brain);
    return brain;
  }
  /** The camera on screen, or the one blending in. Null before the first update or with no enabled camera yet. */
  get live(): VirtualCamera | null {
    return this.layers.at(-1)?.camera ?? null;
  }
  /** True while a blend runs. */
  get blending(): boolean {
    return this.layers.length > 1;
  }
  /** Cameras in the order added. */
  get list(): readonly VirtualCamera[] {
    return this.cameras;
  }
  /**
   * Adds a camera, or makes one from `options`, and returns it.
   * @throws RangeError when the name is taken or the camera was added before.
   */
  add(camera: VirtualCamera | VirtualCameraOptions = {}): VirtualCamera {
    const value = camera instanceof VirtualCamera ? camera : new VirtualCamera(camera);
    if (this.cameras.includes(value)) throw new RangeError('Camera already added; add a camera once');
    if (value.name !== undefined && this.cameras.some((other) => other.name === value.name))
      throw new RangeError(`Camera name '${value.name}' is taken; give each camera of a brain its own name`);
    this.cameras.push(value);
    return value;
  }
  /** Takes a camera out. On screen it holds its last pose until the next camera has blended in. */
  remove(camera: VirtualCamera): void {
    const index = this.cameras.indexOf(camera);
    if (index >= 0) this.cameras.splice(index, 1);
  }
  /**
   * Listens for `'change'`, when a camera starts taking over, or `'blended'`, when one has finished. Returns a function
   * that stops listening.
   * @throws RangeError for another event name.
   */
  on(kind: 'change' | 'blended', listener: BrainListener): () => void {
    const set = this.listeners[kind];
    if (!set) throw new RangeError("Unknown camera brain event; pass 'change' or 'blended'");
    set.add(listener);
    return () => set.delete(listener);
  }
  /** Ends any blend now, so the live camera fills the screen on the next update. */
  cut(): void {
    const top = this.layers.at(-1);
    if (top) this.layers = [top];
  }
  /** The blend from one camera to another: the rules in order, then the `blend` option. */
  blendFor(from: VirtualCamera | null, to: VirtualCamera): CameraBlend {
    const a = from?.name,
      b = to.name,
      rules = this.options.rules ?? [];
    return (
      rules.find((r) => r.from === a && r.to === b) ??
      rules.find((r) => r.from === a && r.to === '*') ??
      rules.find((r) => r.from === '*' && r.to === b) ??
      rules.find((r) => r.from === '*' && r.to === '*') ??
      this.options.blend ?? { duration: 1 }
    );
  }
  private choose(): VirtualCamera | null {
    const shown = this.live;
    let best: VirtualCamera | null = null;
    for (const camera of this.cameras) {
      if (!Number.isFinite(camera.priority)) throw new RangeError('Invalid camera priority; pass a finite number');
      if (camera.enabled && (!best || camera.priority >= best.priority)) best = camera;
    }
    // A tie keeps the picture still.
    return best && shown?.enabled && this.cameras.includes(shown) && shown.priority === best.priority ? shown : best;
  }
  private emit(kind: 'change' | 'blended', from: VirtualCamera | null, to: VirtualCamera, duration: number): void {
    for (const listener of [...this.listeners[kind]]) listener({ from, to, duration });
  }
  private get aspect(): number {
    const canvas = this.engine?.canvas;
    return this.options.aspect ?? (canvas?.height ? canvas.width / canvas.height : 16 / 9);
  }
  /** Moves the running blends on by `delta` and drops every layer a finished one above it has covered. */
  private advance(delta: number): void {
    const layers = this.layers;
    if (layers.length < 2) return;
    let done = 0;
    for (let i = 1; i < layers.length; i++) {
      layers[i].elapsed += delta;
      if (layers[i].elapsed >= layers[i].duration) done = i;
    }
    if (!done) return;
    this.layers = layers.slice(done);
    if (this.layers.length === 1) {
      const top = this.layers[0];
      this.emit('blended', this.blendFrom, top.camera, top.duration);
    }
  }
  /**
   * Picks the camera, steps the blend by `delta` seconds and writes the real camera when attached. Called every frame
   * when attached. With no enabled camera it writes nothing.
   * @throws RangeError for a bad delta, a priority that is not finite, a blend `ease` that gives no number, or a stage's error.
   */
  update(delta: number): CameraPose {
    checkDelta(delta);
    const aspect = this.aspect;
    for (const camera of this.cameras) if (camera.enabled) camera.update(delta, aspect);
    this.advance(delta);
    const next = this.choose(),
      shown = this.live;
    if (!next) return this.pose;
    if (next !== shown) {
      const blend = shown ? this.blendFor(shown, next) : { duration: 0 },
        { duration, ease = smoothstep, style = 'direct' } = blend,
        layer = { camera: next, elapsed: 0, duration, ease, style };
      if (duration > 0) this.layers.push(layer);
      else this.layers = [layer];
      this.blendFrom = shown;
      this.emit('change', shown, next, duration);
      if (!duration) this.emit('blended', shown, next, 0);
    }
    // Cameras a blend still shows keep moving even after they were disabled.
    if (this.layers.length > 1)
      for (const layer of this.layers)
        if (!layer.camera.enabled && this.cameras.includes(layer.camera)) layer.camera.update(delta, aspect);
    copyPose(this.pose, this.layers[0].camera.pose);
    for (let i = 1; i < this.layers.length; i++) {
      const layer = this.layers[i],
        u = layer.ease(layer.elapsed / layer.duration);
      if (!Number.isFinite(u)) throw new RangeError('Invalid camera blend ease; return a number for every value of 0..1');
      blendPose(this.pose, layer.camera.pose, u, layer.style);
    }
    this.context.aspect = aspect;
    for (const stage of this.stages) runStage(stage, this.pose, delta, this.context);
    this.write();
    return this.pose;
  }
  /** Writes the pose, with a screen up that is never parallel to the view (core refuses that). */
  private write(): void {
    const { position, target, up, roll, fov } = this.pose,
      camera = this.options.camera ?? this.engine?.camera,
      last = this.screenUp;
    let fx = target[0] - position[0],
      fy = target[1] - position[1],
      fz = target[2] - position[2];
    const length = Math.hypot(fx, fy, fz);
    if (length > 0) {
      fx /= length;
      fy /= length;
      fz /= length;
      let d = up[0] * fx + up[1] * fy + up[2] * fz,
        ux = up[0] - d * fx,
        uy = up[1] - d * fy,
        uz = up[2] - d * fz;
      // Straight along up, which a blend can pass through: carry on from the last frame's screen up.
      if (Math.hypot(ux, uy, uz) <= 1e-6 * Math.hypot(up[0], up[1], up[2])) {
        d = last[0] * fx + last[1] * fy + last[2] * fz;
        ux = last[0] - d * fx;
        uy = last[1] - d * fy;
        uz = last[2] - d * fz;
        if (Math.hypot(ux, uy, uz) < 1e-6) {
          const small = Math.abs(fx) < 0.9;
          ux = small ? 1 - fx * fx : -fy * fx;
          uy = small ? -fx * fy : 1 - fy * fy;
          uz = small ? -fx * fz : -fy * fz;
        }
      }
      const size = Math.hypot(ux, uy, uz);
      last[0] = ux / size;
      last[1] = uy / size;
      last[2] = uz / size;
    }
    if (!camera) return;
    // Rotate about the view: u cos r + (f x u) sin r, the convention of cutscene's camera roll.
    const c = Math.cos(roll),
      s = Math.sin(roll),
      w = this.outUp;
    w[0] = last[0] * c + (fy * last[2] - fz * last[1]) * s;
    w[1] = last[1] * c + (fz * last[0] - fx * last[2]) * s;
    w[2] = last[2] * c + (fx * last[1] - fy * last[0]) * s;
    for (let i = 0; i < 3; i++) {
      this.outPosition[i] = position[i];
      this.outTarget[i] = target[i];
    }
    camera.position = this.outPosition;
    camera.target = this.outTarget;
    camera.up = w;
    camera.fov = fov;
  }
  /**
   * Plugin hook: bind the brain to `engine`.
   * @throws MargoError `'attached'` when already attached.
   */
  setup(engine: Engine): void {
    if (this.engine)
      throw new MargoError('attached', 'Camera brain already attached; dispose() it before attaching it again');
    this.engine = engine;
  }
  /** Plugin hook: runs {@link CameraBrain.update} with the frame delta in seconds. */
  onPreUpdate(delta: number): void {
    this.update(delta);
  }
  /** Detach from the engine and forget what is on screen; the brain keeps its cameras and can be attached again. */
  dispose(): void {
    const engine = this.engine;
    this.engine = undefined;
    this.layers = [];
    engine?.sceneOf(this)?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
