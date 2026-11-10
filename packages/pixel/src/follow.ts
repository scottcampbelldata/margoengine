/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { type Engine, engineRuntime } from '@margoengine/core/extension';
import { fault, rangeError } from '../../shared/errors.js';
import { ScreenPass, VERTEX } from './blit.js';
import type { PixelCamera } from './camera.js';

/** A position in world units, y down. Objects and live getters can be followed. */
export interface FollowTarget { x: number; y: number }
/** World rectangle, in the same units as the camera. */
export interface FollowBounds extends FollowTarget { width: number; height: number }
/** Linear RGB components in [0, 1]. */
export type FollowColor = readonly [number, number, number];
/** Settings for the whole-pixel camera rig. */
export interface PixelFollowOptions {
  /** Existing camera to drive. Required. */
  camera: PixelCamera;
  /** Live position or getter. Default no following. */
  target?: FollowTarget | (() => FollowTarget);
  /** Fraction closed per 60 Hz frame, scalar or [x, y], in [0,1]. Default 1. Time-correct at other rates. */
  lerp?: number | readonly [number, number];
  /** Centered stationary window in low-res pixels. Default [0,0]. */
  deadZone?: readonly [number, number];
  /** World-space target offset. Default [0,0]. */
  offset?: readonly [number, number];
  /** World bounds. Default unlimited; a smaller-than-view world is centered. */
  bounds?: FollowBounds;
  /** Overlay frame-graph order, after CRT and scaling by default. Default 100. */
  order?: number;
  /** Overlay render-layer bits. Default 1. */
  layers?: number;
  /** Plugin name. Default an automatically unique name. */
  name?: string;
}

const shader = /* wgsl */ `
struct S { rect:vec4i, color:vec4f }
@group(0) @binding(0) var<uniform> s:S;
@group(0) @binding(1) var image:texture_2d<f32>;
${VERTEX}
@fragment fn fs()->@location(0) vec4f { return s.color*textureLoad(image,vec2i(0),0); }
`;
const finite = (value: number, key: string, min = -Infinity, max = Infinity): number => {
  if (!Number.isFinite(value) || value < min || value > max)
    throw rangeError(`PixelFollow ${key} must be finite in [${min}, ${max}], got ${value}`, 'pixel-options');
  return value;
};
const color = (value: FollowColor): FollowColor => value.map(v => finite(v, 'color', 0, 1)) as unknown as FollowColor;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
interface Effect { elapsed: number; duration: number; color: FollowColor; from: number; to: number }
let serial = 0;

/**
 * A GPU-free camera controller when updated manually; attach it to an engine for automatic updates and flash/fade
 * overlays on every matching canvas view. Positions and shakes always land on the low-res pixel lattice.
 * @throws RangeError for invalid durations, positions, bounds or settings; MargoError disposed after disposal.
 */
export class PixelFollow extends ScreenPass {
  /** Camera driven by the rig. */
  readonly camera: PixelCamera;
  /** Live target, or undefined to stop following. Read each update. */
  target?: FollowTarget | (() => FollowTarget);
  /** Per-axis smoothing, read each update. Default 1. */
  lerp: number | readonly [number, number];
  /** Centered dead zone in low-res pixels, read each update. Default [0,0]. */
  deadZone: readonly [number, number];
  /** Target offset in world units, read each update. Default [0,0]. */
  offset: readonly [number, number];
  /** World-space bounds, read each update. */
  bounds?: FollowBounds;
  #position: [number, number];
  #published: [number, number];
  #flash?: Effect;
  #fade?: Effect;
  #shake?: { elapsed: number; duration: number; amplitude: readonly [number, number]; seed: number };
  #rgba = [0, 0, 0, 0];
  #texture: { value?: GPUTexture };
  #host?: Engine;
  #dead = false;
  constructor(options: PixelFollowOptions) {
    const texture: { value?: GPUTexture } = {};
    super({ source: () => texture.value!, fit: 'stretch', order: options.order ?? 100,
      layers: options.layers, name: options.name }, 'PixelFollow', shader, 32, `pixel-follow-${++serial}`);
    if (!options.camera) throw rangeError('PixelFollow needs a camera', 'pixel-options');
    this.camera = options.camera;
    this.target = options.target;
    this.lerp = options.lerp ?? 1;
    this.deadZone = options.deadZone ?? [0, 0];
    this.offset = options.offset ?? [0, 0];
    this.bounds = options.bounds;
    this.#position = [this.camera.x, this.camera.y];
    this.#published = [...this.#position];
    this.#texture = texture;
    this.update(0);
  }
  /** Attaches automatic updates and the view overlays to an engine. */
  static attach(instance: EngineKernel, options: PixelFollowOptions): PixelFollow {
    const rig = new PixelFollow(options);
    engineRuntime(instance).use(rig);
    return rig;
  }
  override setup(engine: Engine): void {
    super.setup(engine);
    this.#host = engine;
    this.#createTexture();
  }
  #createTexture(): void {
    const device = this.#host!.gpu!;
    this.#texture.value = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 6 });
    device.queue.writeTexture({ texture: this.#texture.value }, new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 }, [1, 1]);
  }
  override onDeviceRestored(): void {
    super.onDeviceRestored();
    this.#texture.value?.destroy();
    this.#createTexture();
  }
  override onPreUpdate(delta: number): void { super.onPreUpdate(delta); this.update(delta); }
  /**
   * Advances by nonnegative seconds. Keep the fractional tracking state internally to avoid rounding stalls.
   * Manual camera edits reset tracking from that position. An attached rig is updated by the engine instead.
   */
  update(delta: number): this {
    if (this.#dead) throw fault('disposed', 'PixelFollow disposed; create a new rig', 'disposed');
    finite(delta, 'delta', 0);
    const camera = this.camera, unit = camera.unitsPerPixel;
    const target = typeof this.target === 'function' ? this.target() : this.target;
    const next: [number, number] = [0, 0];
    for (const axis of [0, 1] as const) {
      const key = axis === 0 ? 'x' : 'y', size = axis === 0 ? camera.width : camera.height;
      const current = finite(camera[key], `camera.${key}`);
      if (current !== this.#published[axis]) this.#position[axis] = current;
      const lerp = finite(typeof this.lerp === 'number' ? this.lerp : this.lerp[axis], 'lerp', 0, 1);
      const zone = finite(this.deadZone[axis], 'deadZone', 0, size) * unit / 2;
      const offset = finite(this.offset[axis], 'offset');
      let position = this.#position[axis];
      if (target) {
        const difference = finite(target[key], `target.${key}`) + offset - position - size * unit / 2;
        const distance = difference - clamp(difference, -zone, zone);
        // Keep tiny fractions and long finite intervals representable before converting seconds to frames.
        position += distance * (delta === 0 ? 0 : -Math.expm1(Math.log1p(-lerp) * delta * 60));
      }
      let low = -Infinity, high = Infinity;
      if (this.bounds) {
        const start = finite(this.bounds[key], `bounds.${key}`);
        const span = finite(axis === 0 ? this.bounds.width : this.bounds.height, 'bounds size', 0);
        low = Math.ceil(start / unit); high = Math.floor((start + span - size * unit) / unit);
        if (low > high) low = high = Math.round((start + (span - size * unit) / 2) / unit);
        position = clamp(position, low * unit, high * unit);
      }
      this.#position[axis] = position;
      let shake = 0;
      if (this.#shake) {
        const state = this.#shake, time = state.elapsed + delta;
        if (time < state.duration) {
          let hash = (Math.floor(time * 60) + 1) ^ state.seed ^ (axis * 0x9e3779b9);
          hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
          hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
          shake = Math.round((((hash ^ (hash >>> 16)) >>> 0) / 0xffffffff * 2 - 1) * state.amplitude[axis] * (1 - time / state.duration));
        }
      }
      next[axis] = clamp(Math.round(position / unit) + shake, low, high) * unit;
    }
    if (this.#shake && (this.#shake.elapsed += delta) >= this.#shake.duration) this.#shake = undefined;
    this.camera.x = next[0]; this.camera.y = next[1]; this.#published = next;
    const rgba = [0, 0, 0, 0];
    for (const effect of [this.#fade, this.#flash]) if (effect) {
      effect.elapsed = Math.min(effect.duration, effect.elapsed + delta);
      const a = effect.from + (effect.to - effect.from) * effect.elapsed / effect.duration;
      for (let i = 0; i < 3; i++) rgba[i] = effect.color[i] * a + rgba[i] * (1 - a);
      rgba[3] = a + rgba[3] * (1 - a);
    }
    this.#rgba = rgba;
    return this;
  }
  /** Current premultiplied overlay RGBA. Useful for another renderer or a GPU-free game loop. */
  get overlay(): readonly number[] { return [...this.#rgba]; }
  /** Starts a deterministic decaying shake. Amplitudes are low-res pixels; default 4, duration 0.25 seconds, seed 1. */
  shake(duration = 0.25, amplitude: number | readonly [number, number] = 4, seed = 1): this {
    const pair = typeof amplitude === 'number' ? [amplitude, amplitude] as const : amplitude;
    pair.forEach(v => finite(v, 'amplitude', 0)); finite(seed, 'seed');
    this.#shake = { elapsed: 0, duration: finite(duration, 'duration', Number.MIN_VALUE), amplitude: [...pair], seed };
    return this.update(0);
  }
  /** Flashes from a solid colour to clear. Default 0.25 seconds and white. Replaces an existing flash. */
  flash(duration = 0.25, tint: FollowColor = [1, 1, 1]): this {
    this.#flash = this.#effect(duration, tint, 1, 0); return this.update(0);
  }
  /** Fades to a solid colour and holds it. Default 0.5 seconds and black. */
  fadeOut(duration = 0.5, tint: FollowColor = [0, 0, 0]): this {
    this.#fade = this.#effect(duration, tint, 0, 1); return this.update(0);
  }
  /** Fades from a solid colour to clear. Default 0.5 seconds and black. */
  fadeIn(duration = 0.5, tint: FollowColor = [0, 0, 0]): this {
    this.#fade = this.#effect(duration, tint, 1, 0); return this.update(0);
  }
  #effect(duration: number, tint: FollowColor, from: number, to: number): Effect {
    return { elapsed: 0, duration: finite(duration, 'duration', Number.MIN_VALUE), color: color(tint), from, to };
  }
  /** Stops shake and clears both overlays. Leaves the follow target and camera position intact. */
  resetEffects(): this { this.#shake = this.#flash = this.#fade = undefined; return this.update(0); }
  protected fill(values: ArrayBuffer, rect: readonly number[]): void {
    new Int32Array(values).set(rect); new Float32Array(values).set(this.#rgba, 4);
  }
  override dispose(): void {
    if (this.#dead) return;
    super.dispose(); this.#texture.value?.destroy(); this.#host = undefined; this.#dead = true;
  }
}
