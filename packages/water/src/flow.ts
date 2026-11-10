/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { addSurfaceEffect, surfaceEffects } from './surface-effects.js';
import { flowShader } from './flow-shader.js';
import type { Water } from './index.js';
import { fault, rangeError } from '../../shared/errors.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Painted or generated world-space XZ flow with seamless dual-phase normal advection. */
export interface WaterFlowOptions {
  /** Live Water attached to this engine. */
  surface: Water;
  /** Borrowed RG flow texture, refreshed every draw. Default uniform direction. Undefined while loading uses that default. */
  map?: () => GPUTexture | undefined;
  /** True: RG stores signed vectors. False: decode RG from 0..1 to -1..1. Default false. */
  signed?: boolean;
  /** World XZ lower corner. Default [-50,-50]. */
  origin?: readonly [number, number];
  /** World XZ extent, positive. Default [100,100]. Outside the rectangle flow detail is zero. */
  size?: readonly [number, number];
  /** Uniform fallback direction, components -1..1. Magnitude controls flow speed. Default [1,0]. */
  direction?: readonly [number, number];
  /** Flow speed multiplier, 0..100 m/s. Default 1. */
  speed?: number;
  /** Normal texture repeat length, 0.01..10000 m. Default 4. */
  tileSize?: number;
  /** Repeat period, 0.01..1000 s. Default 4. */
  period?: number;
  /** Slope multiplier, 0..10. Default 0.12. */
  strength?: number;
  /** Two borrowed tangent-space RGBA normal textures, refreshed each draw. Default analytic gradient noise. */
  normalMaps?: readonly [() => GPUTexture | undefined, () => GPUTexture | undefined];
}

let sequence = 0;
const scalar = (v: number, min: number, max: number, name: string) => {
  if (!Number.isFinite(v) || v < min || v > max)
    throw rangeError(`Invalid flow ${name}; pass ${min}..${max}`, 'geometry');
  return v;
};
const pair = (v: readonly [number, number], min: number, max: number, name: string) => {
  if (v.length !== 2) throw rangeError(`Invalid flow ${name}; pass an XZ pair`, 'geometry');
  return [scalar(v[0], min, max, name), scalar(v[1], min, max, name)];
};
const formats = new Set(['rg8unorm', 'rg16float', 'rg32float', 'rgba8unorm', 'rgba16float', 'rgba32float']);

/** Optional river shading driven by local flow vectors; geometry and physical coastal flow remain owned by Water. */
export class WaterFlow implements EnginePlugin {
  readonly name = `water:flow-${sequence++}`;
  private readonly options: WaterFlowOptions;
  private readonly values = new Float32Array(12);
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private fallback?: GPUTexture;
  private fallbackNormal?: GPUTexture;
  private readonly views = new WeakMap<GPUTexture, GPUTextureView>();
  private uniformResource?: GPUBufferBinding;
  private remove?: () => void;
  private removeDispose?: () => void;
  private elapsed = 0;
  private disposed = false;

  constructor(options: WaterFlowOptions) {
    if (!options?.surface || typeof options.surface.onDispose !== 'function')
      throw fault('state', 'Flow needs a Water surface; pass options.surface');
    if (options.map !== undefined && typeof options.map !== 'function')
      throw fault('state', 'Flow map needs a texture provider; pass a function');
    if (options.signed !== undefined && typeof options.signed !== 'boolean')
      throw rangeError('Invalid signed flow option; pass a boolean', 'geometry');
    if (
      options.normalMaps !== undefined &&
      (options.normalMaps.length !== 2 || options.normalMaps.some((v) => typeof v !== 'function'))
    )
      throw fault('state', 'Flow normalMaps need two texture providers; pass a pair of functions');
    const origin = pair(options.origin ?? [-50, -50], -1e7, 1e7, 'origin');
    const size = pair(options.size ?? [100, 100], 0.01, 1e7, 'size');
    const direction = pair(options.direction ?? [1, 0], -1, 1, 'direction') as [number, number];
    this.options = {
      ...options,
      direction,
      signed: options.signed ?? false,
      normalMaps: options.normalMaps ? [...options.normalMaps] : undefined,
    };
    this.values.set([
      ...origin,
      ...size,
      0,
      scalar(options.speed ?? 1, 0, 100, 'speed'),
      scalar(options.tileSize ?? 4, 0.01, 10000, 'tileSize'),
      scalar(options.period ?? 4, 0.01, 1000, 'period'),
      0,
      0,
      scalar(options.strength ?? 0.12, 0, 10, 'strength'),
      0,
    ]);
  }
  /** Attach after the Water surface. */
  static attach(engine: EngineKernel, options: WaterFlowOptions): WaterFlow {
    const value = new WaterFlow(options);
    engineRuntime(engine).use(value);
    return value;
  }
  /** Set deterministic flow animation time in seconds; zero is the initial frame. */
  setTime(seconds: number): this {
    this.live();
    this.elapsed = scalar(seconds, 0, 1e9, 'time');
    return this;
  }
  onPreUpdate(delta: number): void {
    if (delta > 0) this.elapsed += delta;
  }
  setup(engine: Engine): void {
    this.live();
    if (this.engine) throw fault('attached', 'Flow already attached; create another WaterFlow', 'state');
    if (!engine.gpu) throw fault('unsupported', 'Flow needs WebGPU or the full WebGL2 compatibility layer', 'webgpu');
    if (!engine.hasPlugin(this.options.surface.name))
      throw fault('state', 'Attach the Water surface to this engine before WaterFlow');
    if (surfaceEffects.get(this.options.surface)?.some((e) => e.key === 'flow'))
      throw fault('attached', 'Water already has flow; dispose it before attaching another WaterFlow', 'state');
    this.engine = engine;
    const device = engine.gpu;
    this.uniform = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.uniformResource = { buffer: this.uniform };
    const texture = (data: Float32Array) => {
      const t = device.createTexture({
        size: [1, 1],
        format: 'rgba32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture({ texture: t }, data, { bytesPerRow: 16 }, [1, 1]);
      return t;
    };
    const d = this.options.direction!;
    this.fallback = texture(new Float32Array([d[0], d[1], 0, 1]));
    this.fallbackNormal = texture(new Float32Array([0.5, 0.5, 1, 1]));
    this.remove = addSurfaceEffect(this.options.surface, {
      key: 'flow',
      vertex: false,
      count: 4,
      shader: (code, binding) => {
        if (code.split('let n=normalize(i.normal+ripple').length !== 2)
          throw fault('failed', 'Flow cannot find the Water surface shader; use matching water package versions');
        return (
          code
            .replace('struct Result', flowShader(binding) + '\nstruct Result')
            // The prefix without the closing bracket still matches after WaterRain adds its rings, in either order.
            .replace(
              'let n=normalize(i.normal+ripple',
              'ripple=flowingNormal(i.world.xz,footprint)*(1.0-foam);let n=normalize(i.normal+ripple',
            )
        );
      },
      prepare: (c) => this.prepare(c),
    });
    this.removeDispose = this.options.surface.onDispose(() => this.dispose());
  }
  private view(texture: GPUTexture, normal = false): GPUTextureView {
    if (
      texture.dimension !== '2d' ||
      texture.depthOrArrayLayers !== 1 ||
      texture.sampleCount !== 1 ||
      !formats.has(texture.format) ||
      (normal && !texture.format.startsWith('rgba')) ||
      !(texture.usage & GPUTextureUsage.TEXTURE_BINDING)
    )
      throw fault(
        'failed',
        'Flow needs a sampleable non-sRGB RG or RGBA float/unorm 2D texture; pass a linear single-layer texture',
        'material',
      );
    let view = this.views.get(texture);
    if (!view) {
      view = texture.createView();
      this.views.set(texture, view);
    }
    return view;
  }
  private prepare(c: Context): readonly GPUBindingResource[] {
    if (c.device !== this.engine?.gpu)
      throw fault('state', 'Flow and Water must use the same engine; attach both to one engine');
    const map = this.options.map?.();
    const normals = this.options.normalMaps?.map((provider) => provider());
    this.values[4] = this.elapsed;
    this.values[8] = +(!map || !!this.options.signed);
    this.values[9] = +(!!normals?.[0] && !!normals[1]);
    c.device.queue.writeBuffer(this.uniform!, 0, this.values);
    return [
      this.uniformResource!,
      this.view(map ?? this.fallback!),
      this.view(normals?.[0] ?? this.fallbackNormal!, true),
      this.view(normals?.[1] ?? this.fallbackNormal!, true),
    ];
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }
  private live(): void {
    if (this.disposed) throw fault('disposed', 'Flow disposed; create another WaterFlow');
  }
  private release(): void {
    this.remove?.();
    this.removeDispose?.();
    this.remove = this.removeDispose = undefined;
    this.uniform?.destroy();
    this.fallback?.destroy();
    this.fallbackNormal?.destroy();
    this.uniform = undefined;
    this.fallback = this.fallbackNormal = undefined;
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
