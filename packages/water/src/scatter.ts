/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { addSurfaceEffect, surfaceEffects } from './surface-effects.js';
import { scatterShader } from './scatter-shader.js';
import type { Water } from './index.js';
import { fault, rangeError } from '../../shared/errors.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Look of the light that glows through thin, backlit wave crests. Every field is optional. */
export interface WaterScatterSettings {
  /** Linear RGB tint of the scattered light, each 0 to 1. Default [0.04, 0.32, 0.24], a blue green. */
  color?: readonly [number, number, number];
  /** Brightness multiplier, 0 to 100. Default 1. Zero turns the glow off. */
  strength?: number;
  /** How tightly the glow gathers around the light, 0.5 to 64. Default 4. */
  power?: number;
  /** How much the wave normal bends the light's path, 0 to 1. Default 0.3. */
  distortion?: number;
}
/** Settings for {@link WaterScatter}: a live Water plus the look. */
export interface WaterScatterOptions extends WaterScatterSettings {
  /** Live Water attached to this engine. */
  surface: Water;
}

const DEFAULTS = { color: [0.04, 0.32, 0.24] as const, strength: 1, power: 4, distortion: 0.3 };
const scalar = (v: unknown, min: number, max: number, name: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    throw rangeError(`Invalid water scatter ${name}; pass ${min}..${max}`, 'geometry');
  return v;
};
let sequence = 0;

/**
 * Subsurface scattering in waves: light from Water's directional lights glows through crests the viewer sees against
 * the light, tinted, in the shadow map's visibility. It shades only; geometry, queries and SSR capture are unchanged.
 */
export class WaterScatter implements EnginePlugin {
  readonly name = `water:scatter-${sequence++}`;
  private readonly surface: Water;
  private readonly values = new Float32Array(8);
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private resources: GPUBindingResource[] = [];
  private dirty = true;
  private remove?: () => void;
  private removeDispose?: () => void;
  private disposed = false;

  constructor(options: WaterScatterOptions) {
    if (!options?.surface || typeof options.surface.onDispose !== 'function')
      throw fault('state', 'Water scatter needs a Water surface; pass options.surface');
    this.surface = options.surface;
    this.values.set([...DEFAULTS.color, DEFAULTS.strength, DEFAULTS.power, DEFAULTS.distortion]);
    this.set(options);
  }
  /** Attach after the Water surface (and after WaterBodies, so the glow measures crests from each body's level). */
  static attach(engine: EngineKernel, options: WaterScatterOptions): WaterScatter {
    const value = new WaterScatter(options);
    engineRuntime(engine).use(value);
    return value;
  }
  /** Change any settings; checks them all before changing any. */
  set(settings: WaterScatterSettings): this {
    this.live();
    const next = this.values.slice();
    if (settings.color !== undefined) {
      if (!Array.isArray(settings.color) || settings.color.length !== 3)
        throw rangeError('Invalid water scatter color; pass linear [r, g, b]', 'geometry');
      next.set(settings.color.map((c) => scalar(c, 0, 1, 'color')));
    }
    if (settings.strength !== undefined) next[3] = scalar(settings.strength, 0, 100, 'strength');
    if (settings.power !== undefined) next[4] = scalar(settings.power, 0.5, 64, 'power');
    if (settings.distortion !== undefined) next[5] = scalar(settings.distortion, 0, 1, 'distortion');
    this.values.set(next);
    this.dirty = true;
    return this;
  }
  /** Settings in use. */
  get settings(): Required<WaterScatterSettings> {
    const v = this.values;
    return { color: [v[0], v[1], v[2]], strength: v[3], power: v[4], distortion: v[5] };
  }
  setup(engine: Engine): void {
    this.live();
    if (this.engine) throw fault('attached', 'Water scatter already attached; create another WaterScatter', 'state');
    if (!engine.gpu)
      throw fault('unsupported', 'Water scatter needs WebGPU or the full WebGL2 compatibility layer', 'webgpu');
    if (!engine.hasPlugin(this.surface.name))
      throw fault('state', 'Attach the Water surface to this engine before WaterScatter');
    if (surfaceEffects.get(this.surface)?.some((e) => e.key === 'scatter'))
      throw fault('attached', 'Water already has scatter; call set on the attached one', 'state');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.resources = [{ buffer: this.uniform }];
    this.dirty = true;
    this.remove = addSurfaceEffect(this.surface, {
      key: 'scatter',
      vertex: false,
      count: 1,
      shader: (code, binding) => {
        const mark = 'let body=bottom*transmission+';
        if (code.split(mark).length !== 2)
          throw fault(
            'failed',
            'Water scatter cannot find the Water surface shader; use matching water package versions',
          );
        // With WaterBodies attached first, crests are measured from each body's own level and wave share.
        const base = code.includes('fn bodySample(') ? 'bodySample(xz).yz' : 'vec2f(frame.settings.y,1.0)';
        return code
          .replace('struct Result', scatterShader(binding, base) + '\nstruct Result')
          .replace(mark, 'let body=waterScatter(i.world,i.xz,i.crest,n,v)+bottom*transmission+');
      },
      prepare: (c) => this.prepare(c),
    });
    this.removeDispose = this.surface.onDispose(() => this.dispose());
  }
  private prepare(c: Context): readonly GPUBindingResource[] {
    if (c.device !== this.engine?.gpu)
      throw fault('state', 'Water scatter and Water must use the same engine; attach both to one engine');
    if (this.dirty) {
      c.device.queue.writeBuffer(this.uniform!, 0, this.values);
      this.dirty = false;
    }
    return this.resources;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }
  private live(): void {
    if (this.disposed) throw fault('disposed', 'Water scatter disposed; create another WaterScatter');
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
