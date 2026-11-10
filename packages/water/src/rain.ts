/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { addSurfaceEffect, surfaceEffects } from './surface-effects.js';
import { rainShader } from './rain-shader.js';
import type { Water } from './index.js';
import type { Ripples } from './ripples.js';
import { fault, rangeError } from '../../shared/errors.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/**
 * Where the rain intensity 0 to 1 comes from, read every frame: a `WeatherMachine` from `@margoengine/weather` (its
 * `state.rain`) or any object with a numeric `rain`.
 */
export type WaterRainSource = { readonly rain: number } | { readonly state: { readonly rain: number } };
/** Heavier drops that also disturb a `Ripples` field, so the rain moves the simulated surface and what floats on it. */
export interface WaterRainSplashes {
  /** Live ripple field on the same Water. */
  field: Ripples;
  /** Splashes per second at full rain, 0 to 1000. Default 20. */
  rate?: number;
  /** Side of the square around the camera they fall in, metres, 0.1 to 10000. Default 16; keep it inside the field. */
  area?: number;
  /** Splash radius in metres, at least one ripple cell. Default 0.5. */
  radius?: number;
  /** Splash depth in metres, 0 to 10. Default 0.02. */
  depth?: number;
}
/** Settings for {@link WaterRain}. */
export interface WaterRainOptions {
  /** Live Water attached to this engine. */
  surface: Water;
  /** The weather to follow; while set its rain intensity drives the rings. Default none. */
  weather?: WaterRainSource;
  /** Rain intensity when no `weather` is set, 0 to 1. Default 1. */
  rain?: number;
  /** Width of one ring cell in metres, 0.05 to 5; each of three grids holds one ring per cell at a time. Default 0.4. */
  cell?: number;
  /** Seconds a ring lives while it spreads to a quarter of the cell, 0.1 to 10. Default 0.8. */
  lifetime?: number;
  /** Steepest normal tilt of a fresh ring, 0 to 1. Default 0.35. */
  strength?: number;
  /** Optional splashes into a GPU ripple field. */
  splashes?: WaterRainSplashes;
}

const scalar = (v: unknown, min: number, max: number, name: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    throw rangeError(`Invalid water rain ${name}; pass ${min}..${max}`, 'geometry');
  return v;
};
let sequence = 0;

/**
 * Rain drop rings on Water, driven by a weather's rain intensity: shading-only rings at every scale the camera
 * resolves, plus optional splashes into a `Ripples` field. Attach after the Water surface.
 */
export class WaterRain implements EnginePlugin {
  readonly name = `water:rain-${sequence++}`;
  private readonly surface: Water;
  private readonly weather?: WaterRainSource;
  private rainValue: number;
  private readonly splashes?: Required<WaterRainSplashes>;
  private readonly values = new Float32Array(8);
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private resources: GPUBindingResource[] = [];
  private remove?: () => void;
  private removeDispose?: () => void;
  private elapsed = 0;
  private pendingTime = 0;
  private owed = 0;
  private seed = 1;
  private disposed = false;

  constructor(options: WaterRainOptions) {
    if (!options?.surface || typeof options.surface.onDispose !== 'function')
      throw fault('state', 'Water rain needs a Water surface; pass options.surface');
    if (options.weather !== undefined && (typeof options.weather !== 'object' || options.weather === null))
      throw rangeError(
        'Invalid water rain weather; pass a WeatherMachine or an object with a numeric rain',
        'geometry',
      );
    this.surface = options.surface;
    this.weather = options.weather;
    this.rainValue = scalar(options.rain ?? 1, 0, 1, 'rain');
    this.values.set([
      0,
      0,
      scalar(options.cell ?? 0.4, 0.05, 5, 'cell'),
      scalar(options.strength ?? 0.35, 0, 1, 'strength'),
      scalar(options.lifetime ?? 0.8, 0.1, 10, 'lifetime'),
    ]);
    const s = options.splashes;
    if (s !== undefined) {
      if (!s?.field || typeof s.field.disturb !== 'function')
        throw fault('state', 'Water rain splashes need a Ripples field; pass splashes.field');
      this.splashes = {
        field: s.field,
        rate: scalar(s.rate ?? 20, 0, 1000, 'splash rate'),
        area: scalar(s.area ?? 16, 0.1, 10000, 'splash area'),
        radius: scalar(s.radius ?? 0.5, 0.001, 10000, 'splash radius'),
        depth: scalar(s.depth ?? 0.02, 0, 10, 'splash depth'),
      };
    }
  }
  /** Attach after the Water surface (and after any Ripples the splashes use). */
  static attach(engine: EngineKernel, options: WaterRainOptions): WaterRain {
    const value = new WaterRain(options);
    engineRuntime(engine).use(value);
    return value;
  }
  /** Rain intensity in use: the weather's (clamped to 0..1, 0 when missing or not finite), else the set value. */
  get rain(): number {
    if (!this.weather) return this.rainValue;
    const w = this.weather as { rain?: unknown; state?: { rain?: unknown } };
    const r = 'rain' in w ? w.rain : w.state?.rain;
    return typeof r === 'number' && Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0;
  }
  /** Set the intensity used when no weather is attached, 0 to 1. */
  set rain(value: number) {
    this.live();
    this.rainValue = scalar(value, 0, 1, 'rain');
  }
  /** Set deterministic ring time in seconds; zero is the initial frame. */
  setTime(seconds: number): this {
    this.live();
    this.elapsed = scalar(seconds, 0, 1e9, 'time');
    return this;
  }
  onPreUpdate(delta: number): void {
    if (delta > 0) {
      this.elapsed += delta;
      this.pendingTime += delta;
    }
  }
  setup(engine: Engine): void {
    this.live();
    if (this.engine) throw fault('attached', 'Water rain already attached; create another WaterRain', 'state');
    if (!engine.gpu)
      throw fault('unsupported', 'Water rain needs WebGPU or the full WebGL2 compatibility layer', 'webgpu');
    if (!engine.hasPlugin(this.surface.name))
      throw fault('state', 'Attach the Water surface to this engine before WaterRain');
    if (surfaceEffects.get(this.surface)?.some((e) => e.key === 'rain'))
      throw fault('attached', 'Water already has rain; change the attached one', 'state');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.resources = [{ buffer: this.uniform }];
    this.remove = addSurfaceEffect(this.surface, {
      key: 'rain',
      vertex: false,
      count: 1,
      shader: (code, binding) => {
        // The prefix without the closing bracket also matches after WaterFlow's insertion, in either order.
        const mark = 'let n=normalize(i.normal+ripple';
        if (code.split(mark).length !== 2)
          throw fault('failed', 'Water rain cannot find the Water surface shader; use matching water package versions');
        return code
          .replace('struct Result', rainShader(binding) + '\nstruct Result')
          .replace(mark, mark + '+rainRipple(i.world.xz,footprint)*(1.0-foam)');
      },
      prepare: (c) => this.prepare(c),
    });
    this.removeDispose = this.surface.onDispose(() => this.dispose());
  }
  private random(): number {
    // Park and Miller minimal standard generator (CACM 31(10), 1988): deterministic splash places.
    this.seed = (this.seed * 48271) % 2147483647;
    return this.seed / 2147483647;
  }
  private prepare(c: Context): readonly GPUBindingResource[] {
    if (c.device !== this.engine?.gpu)
      throw fault('state', 'Water rain and Water must use the same engine; attach both to one engine');
    const rain = this.rain;
    this.values[0] = this.elapsed;
    this.values[1] = rain;
    c.device.queue.writeBuffer(this.uniform!, 0, this.values);
    const s = this.splashes;
    if (s) {
      this.owed += Math.min(0.25, this.pendingTime) * s.rate * rain;
      // At most 32 splashes a frame leave room in the field's 64-event queue for wakes.
      const count = Math.min(32, Math.floor(this.owed));
      this.owed -= Math.floor(this.owed);
      const [x, , z] = c.camera.position;
      for (let i = 0; i < count; i++)
        s.field.disturb(x + (this.random() - 0.5) * s.area, z + (this.random() - 0.5) * s.area, s.radius, -s.depth);
    }
    this.pendingTime = 0;
    return this.resources;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }
  private live(): void {
    if (this.disposed) throw fault('disposed', 'Water rain disposed; create another WaterRain');
  }
  private release(): void {
    this.remove?.();
    this.removeDispose?.();
    this.remove = this.removeDispose = undefined;
    this.uniform?.destroy();
    this.uniform = undefined;
    this.resources = [];
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
