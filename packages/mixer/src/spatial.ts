/// <reference lib="esnext.disposable" preserve="true" />
// Positional sound sources and the listener pose. A source is a PannerNode feeding a bus; the listener is the
// context's own AudioListener, which is what `@margoengine/audio`'s AudioListener updates from the camera each frame.
import { MargoError } from '@margoengine/math/errors';

/** A point or direction in world space. */
export type Vec3 = readonly [number, number, number];

/** Settings of an {@link Emitter}. */
export interface EmitterOptions {
  /** World position in metres. Default `[0, 0, 0]`. */
  position?: Vec3;
  /** Direction the source faces (for the cone). Default `[0, 0, 1]`. */
  orientation?: Vec3;
  /** Distance model of the Web Audio specification. Default `'inverse'`. */
  distanceModel?: DistanceModelType;
  /** Distance with full volume, metres, above 0. Default 1. */
  refDistance?: number;
  /** Distance beyond which the volume stops falling (not a cut-off), metres. Default 10000. */
  maxDistance?: number;
  /** How fast the volume falls with distance, 0 or more. Default 1. */
  rolloffFactor?: number;
  /** `'HRTF'` for headphones or `'equalpower'` for speakers. Default `'HRTF'`. */
  panningModel?: PanningModelType;
  /** Cone angles in degrees and the gain outside the outer cone (0..1). Default no cone. */
  cone?: { inner: number; outer: number; outerGain: number };
}

const vec = (value: Vec3 | undefined, fallback: Vec3, name: string): Vec3 => {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length !== 3 || value.some((v) => typeof v !== 'number' || !Number.isFinite(v)))
    throw new TypeError(`${name} must be three finite numbers [x, y, z]`);
  return value;
};

/** Moves a parameter to `value` now or at `time`, smoothly (about 20 ms) on a running context. */
function move(context: BaseAudioContext, param: AudioParam, value: number, at?: number): void {
  const time = at ?? context.currentTime;
  param.cancelScheduledValues(time);
  if (time <= context.currentTime && context.state !== 'running') param.setValueAtTime(value, time);
  else param.setTargetAtTime(value, time, 0.005);
}

/**
 * A sound source with a position. Connect your source to {@link Emitter.input}; the sound comes out of the bus the
 * emitter was made for, panned and attenuated against the context listener.
 */
export class Emitter implements Disposable {
  /** Connect sources here. */
  readonly input: PannerNode;
  private disposed = false;

  /** @internal Use `mixer.emitter(bus, options)`. */
  constructor(
    private readonly context: BaseAudioContext,
    destination: AudioNode,
    options: EmitterOptions = {},
  ) {
    const panner = context.createPanner(),
      [x, y, z] = vec(options.position, [0, 0, 0], 'position'),
      [ox, oy, oz] = vec(options.orientation, [0, 0, 1], 'orientation');
    const refDistance = options.refDistance ?? 1,
      rolloff = options.rolloffFactor ?? 1;
    if (!(refDistance > 0)) throw new RangeError(`refDistance must be above 0, got ${refDistance}`);
    if (!(rolloff >= 0)) throw new RangeError(`rolloffFactor must be 0 or more, got ${rolloff}`);
    panner.panningModel = options.panningModel ?? 'HRTF';
    panner.distanceModel = options.distanceModel ?? 'inverse';
    panner.refDistance = refDistance;
    panner.maxDistance = options.maxDistance ?? 10000;
    panner.rolloffFactor = rolloff;
    if (options.cone) {
      panner.coneInnerAngle = options.cone.inner;
      panner.coneOuterAngle = options.cone.outer;
      panner.coneOuterGain = options.cone.outerGain;
    }
    this.input = panner;
    this.set(panner.positionX, x);
    this.set(panner.positionY, y);
    this.set(panner.positionZ, z);
    this.set(panner.orientationX, ox);
    this.set(panner.orientationY, oy);
    this.set(panner.orientationZ, oz);
    panner.connect(destination);
  }

  private set(param: AudioParam, value: number): void {
    param.value = value;
  }

  /** Moves the source. `at` is an AudioContext time (default now). */
  setPosition(x: number, y: number, z: number, at?: number): this {
    this.alive();
    vec([x, y, z], [0, 0, 0], 'position');
    move(this.context, this.input.positionX, x, at);
    move(this.context, this.input.positionY, y, at);
    move(this.context, this.input.positionZ, z, at);
    return this;
  }

  /** Turns the source to face `direction`. */
  setOrientation(x: number, y: number, z: number, at?: number): this {
    this.alive();
    vec([x, y, z], [0, 0, 0], 'orientation');
    move(this.context, this.input.orientationX, x, at);
    move(this.context, this.input.orientationY, y, at);
    move(this.context, this.input.orientationZ, z, at);
    return this;
  }

  private alive(): void {
    if (this.disposed) throw new MargoError('disposed', 'Emitter is disposed; create a new one with mixer.emitter()');
  }

  /** Disconnects the emitter. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.disconnect();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Where the listener stands and looks. */
export interface ListenerPose {
  /** World position in metres. */
  position: Vec3;
  /** Direction the listener faces. */
  forward: Vec3;
  /** Which way is up. Default `[0, 1, 0]`. */
  up?: Vec3;
}

/**
 * Writes a pose to a Web Audio listener, for example from the camera: forward is the direction from the camera
 * position to its target. Use this when you do not run `@margoengine/audio`'s AudioListener, which does the same
 * every frame. `at` is an AudioContext time (default now).
 */
export function setListenerPose(context: BaseAudioContext, pose: ListenerPose, at?: number): void {
  const [px, py, pz] = vec(pose.position, [0, 0, 0], 'position'),
    [fx, fy, fz] = vec(pose.forward, [0, 0, -1], 'forward'),
    [ux, uy, uz] = vec(pose.up, [0, 1, 0], 'up');
  if (fx === 0 && fy === 0 && fz === 0) throw new RangeError('forward must not be the zero vector');
  const l = context.listener;
  move(context, l.positionX, px, at);
  move(context, l.positionY, py, at);
  move(context, l.positionZ, pz, at);
  move(context, l.forwardX, fx, at);
  move(context, l.forwardY, fy, at);
  move(context, l.forwardZ, fz, at);
  move(context, l.upX, ux, at);
  move(context, l.upY, uy, at);
  move(context, l.upZ, uz, at);
}
