/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type PassContext,
  type FramePass,
} from '@margoengine/core/extension';
import { addSurfaceEffect, surfaceEffects } from './surface-effects.js';
import type { Water } from './index.js';
import { fault, rangeError } from '../../shared/errors.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Borrowed environment/reflector capture. Both values describe the same last successful update. */
export interface WaterPlanarCapture {
  /** Single-layer sampleable linear rgba16float capture, undefined until ready. */
  readonly texture: GPUTexture | undefined;
  /** World-to-WebGPU-clip projection belonging to texture, undefined until ready. */
  readonly textureMatrix: ArrayLike<number> | undefined;
  /** Optional scene-pass filter, temporarily wrapped to omit the consuming Water draw. Configure before attachment. */
  passes?: (pass: FramePass) => boolean;
}
/** Construction settings for calm-water planar reflections; the source is read each draw. */
export interface WaterReflectionOptions {
  /** Live Water in the same engine. */
  surface: Water;
  /** Reflector configured with captureOnly:true and a horizontal plane aligned to the water height. */
  reflector: WaterPlanarCapture;
  /** Fraction of planar colour versus existing sky, 0..1. Default 1. */
  strength?: number;
  /** Reflection-ray XZ distortion in texture fractions, 0..0.1. Default 0 for calm water. */
  distortion?: number;
  /** Cross-filter blur, 0..1 (up to eight capture texels). Default 0. */
  roughness?: number;
  /** Nonnegative linear RGB multiplier, each 0..100. Default [1,1,1]. */
  color?: readonly [number, number, number];
}

type SourceFilter = {
  original: (pass: FramePass) => boolean;
  filter: (pass: FramePass) => boolean;
  names: Set<string>;
};
const sourceFilters = new WeakMap<WaterPlanarCapture, SourceFilter>();
function excludeSurface(source: WaterPlanarCapture, name: string): () => void {
  if (!source.passes) return () => {};
  let record = sourceFilters.get(source);
  if (!record || source.passes !== record.filter) {
    const original = source.passes,
      names = new Set<string>();
    record = { original, names, filter: (pass) => !names.has(pass.name) && original(pass) };
    sourceFilters.set(source, record);
    source.passes = record.filter;
  }
  const entry = record;
  entry.names.add(name);
  return () => {
    entry.names.delete(name);
    if (!entry.names.size) {
      if (source.passes === entry.filter) source.passes = entry.original;
      if (sourceFilters.get(source) === entry) sourceFilters.delete(source);
    }
  };
}
let sequence = 0;
const scalar = (value: number, min: number, max: number, name: string) => {
  if (!Number.isFinite(value) || value < min || value > max)
    throw rangeError(`Invalid water reflection ${name}; pass ${min}..${max}`, 'material');
  return value;
};
const declarations = (binding: number) => `
struct PlanarWaterFrame { projection:mat4x4f, settings:vec4f, tint:vec4f }
@group(0) @binding(${binding}) var<uniform> planarWater:PlanarWaterFrame;
@group(0) @binding(${binding + 1}) var planarWaterImage:texture_2d<f32>;
@group(0) @binding(${binding + 2}) var planarWaterSampler:sampler;
var<private> planarWaterWorld:vec3f;
fn skyColor(direction:vec3f,rough:f32)->vec3f {
 let fallback=skyColorBase(direction,rough);
 if(planarWater.settings.x<0.5){return fallback;}
 let clip=planarWater.projection*vec4f(planarWaterWorld,1);
 if(clip.w<=0.000001){return fallback;}
 let uv=clip.xy/clip.w*vec2f(0.5,-0.5)+0.5+direction.xz*planarWater.settings.z;
 if(any(uv<vec2f(0))||any(uv>vec2f(1))){return fallback;}
 var color=textureSampleLevel(planarWaterImage,planarWaterSampler,uv,0).rgb;
 if(planarWater.settings.w>0.0){
  let offset=vec2f(planarWater.settings.w*8.0)/vec2f(textureDimensions(planarWaterImage));
  color=color*0.5+(textureSampleLevel(planarWaterImage,planarWaterSampler,uv+vec2f(offset.x,0),0).rgb+textureSampleLevel(planarWaterImage,planarWaterSampler,uv-vec2f(offset.x,0),0).rgb+textureSampleLevel(planarWaterImage,planarWaterSampler,uv+vec2f(0,offset.y),0).rgb+textureSampleLevel(planarWaterImage,planarWaterSampler,uv-vec2f(0,offset.y),0).rgb)*0.125;
 }
 return mix(fallback,color*planarWater.tint.rgb,planarWater.settings.y);
}
`;

/** Project environment's planar capture into Water's existing Fresnel term, including its SSR capture. */
export class WaterReflection implements EnginePlugin {
  readonly name = `water:reflection-${sequence++}`;
  private readonly surface: Water;
  private readonly source: WaterPlanarCapture;
  private readonly values = new Float32Array(24);
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private uniformResource?: GPUBufferBinding;
  private fallback?: GPUTexture;
  private sampler?: GPUSampler;
  private readonly views = new WeakMap<GPUTexture, GPUTextureView>();
  private remove?: () => void;
  private removeDispose?: () => void;
  private disposed = false;
  private removeFilter?: () => void;
  constructor(options: WaterReflectionOptions) {
    if (!options?.surface || typeof options.surface.onDispose !== 'function' || !options.reflector)
      throw fault(
        'state',
        'WaterReflection needs surface and reflector; pass a live Water and an environment Reflector',
      );
    this.surface = options.surface;
    this.source = options.reflector;
    const color = options.color ?? [1, 1, 1];
    if (color.length !== 3) throw rangeError('Invalid reflection color; pass three linear RGB components', 'material');
    this.values[17] = scalar(options.strength ?? 1, 0, 1, 'strength');
    this.values[18] = scalar(options.distortion ?? 0, 0, 0.1, 'distortion');
    this.values[19] = scalar(options.roughness ?? 0, 0, 1, 'roughness');
    this.values.set(
      color.map((v) => scalar(v, 0, 100, 'color')),
      20,
    );
  }
  /** Attach after Water; update the borrowed Reflector before manual engine.render calls. */
  static attach(engine: EngineKernel, options: WaterReflectionOptions): WaterReflection {
    const value = new WaterReflection(options);
    engineRuntime(engine).use(value);
    return value;
  }
  setup(engine: Engine): void {
    this.live();
    if (this.engine) throw fault('attached', 'WaterReflection already attached; create another instance', 'state');
    if (!engine.gpu)
      throw fault('unsupported', 'Planar water needs WebGPU or the full WebGL2 compatibility layer', 'webgpu');
    if (!engine.hasPlugin(this.surface.name))
      throw fault('state', 'Attach the live Water to this engine before WaterReflection');
    if (surfaceEffects.get(this.surface)?.some((e) => e.key === 'reflector'))
      throw fault('attached', 'Water already has planar reflection; dispose it before replacing', 'state');
    this.removeFilter = excludeSurface(this.source, this.surface.name + ':draw');
    this.engine = engine;
    const device = engine.gpu;
    this.uniform = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.uniformResource = { buffer: this.uniform };
    this.fallback = device.createTexture({
      size: [1, 1],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.sampler = device.createSampler({
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.remove = addSurfaceEffect(this.surface, {
      key: 'reflector',
      vertex: false,
      count: 3,
      shader: (code, binding) =>
        code
          .replace('fn skyColor(direction:vec3f,rough:f32)', 'fn skyColorBase(direction:vec3f,rough:f32)')
          .replace('struct Result', declarations(binding) + '\nstruct Result')
          .replace(
            '@fragment fn fragment(i:Output)->Result{',
            '@fragment fn fragment(i:Output)->Result{\nplanarWaterWorld=i.world;',
          ),
      prepare: (c) => this.prepare(c),
    });
    this.removeDispose = this.surface.onDispose(() => this.dispose());
  }
  private prepare(c: Context): readonly GPUBindingResource[] {
    if (c.device !== this.engine?.gpu)
      throw fault('state', 'WaterReflection and Water must share an engine; attach them to the same engine');
    const texture = this.source.texture,
      matrix = this.source.textureMatrix;
    if (
      texture &&
      (texture.dimension !== '2d' ||
        texture.depthOrArrayLayers !== 1 ||
        texture.sampleCount !== 1 ||
        texture.format !== 'rgba16float' ||
        !(texture.usage & GPUTextureUsage.TEXTURE_BINDING))
    )
      throw fault(
        'failed',
        'Planar water needs a sampleable rgba16float 2D capture; use environment Reflector.texture',
        'material',
      );
    if (
      texture &&
      (!matrix || matrix.length !== 16 || Array.from(matrix).some((v) => !Number.isFinite(Math.fround(v))))
    )
      throw fault(
        'failed',
        'Planar water needs the matching finite capture matrix; use Reflector.textureMatrix',
        'state',
      );
    this.values[16] = +!!texture;
    if (texture) this.values.set(Array.from(matrix!), 0);
    c.device.queue.writeBuffer(this.uniform!, 0, this.values);
    const image = texture ?? this.fallback!;
    let view = this.views.get(image);
    if (!view) {
      view = image.createView();
      this.views.set(image, view);
    }
    return [this.uniformResource!, view, this.sampler!];
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }
  private live(): void {
    if (this.disposed) throw fault('disposed', 'WaterReflection disposed; create another instance');
  }
  private release(): void {
    this.removeFilter?.();
    this.removeFilter = undefined;
    this.remove?.();
    this.removeDispose?.();
    this.remove = this.removeDispose = undefined;
    this.uniform?.destroy();
    this.fallback?.destroy();
    this.uniform = undefined;
    this.fallback = undefined;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
