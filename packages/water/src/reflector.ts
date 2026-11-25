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
import { reflectionConeShader } from '../../shared/reflection-cone.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Borrowed environment/reflector capture. Both values describe the same last successful update. */
export interface WaterPlanarCapture {
  /** Single-layer sampleable linear rgba16float capture, undefined until ready. */
  readonly texture: GPUTexture | undefined;
  /** World-to-WebGPU-clip projection belonging to texture, undefined until ready. */
  readonly textureMatrix: ArrayLike<number> | undefined;
  /** The capture with its mip chain (environment Reflector with `roughness` above 0), read by `contactHardening`. */
  readonly blurTexture?: GPUTexture | undefined;
  /** The capture's depth through textureMatrix, read by `contactHardening`. */
  readonly depthTexture?: GPUTexture | undefined;
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
  /** Strength of the water-normal distortion in the capture's projection, 0..0.1. Default 0. */
  distortion?: number;
  /** Cross-filter blur, 0..1, modulated by the local surface roughness; with `contactHardening`, the lowest roughness of the cone. Default 0. */
  roughness?: number;
  /**
   * Blur the reflection by a cone from the water's own roughness (its waves and ripples, at least `roughness`): sharp
   * where a pier or hull meets the water, blurrier with distance from it. Reads the Reflector's `blurTexture` and
   * `depthTexture`, so give the Reflector a `roughness` above 0 (1 builds the full mip chain). Fixed at construction.
   * Default false.
   */
  contactHardening?: boolean;
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
// Contact hardening: the capture depth under the lookup gives the reflected ray's distance to what it shows, and the
// cone at that distance picks the mip (shared/reflection-cone.js); the edge and horizon fades then span that mip's
// texel. The cone's roughness is the waves' slope variance inside the pixel (alpha^2 = 2 variance, after Toksvig 2005;
// the waves the pixel resolves already bend the lookup), and at least the `roughness` option. Water's own `rough` is
// not used: its floor is tuned for the sun's glitter and blurred even calm water's reflections away.
const variance = 'let variance=(dot(normalDx,normalDx)+dot(normalDy,normalDy))/12.0;';
const coneBlur = `let planarWaterRay=margoCaptureRay(planarWater.projection,planarWaterWorld,margoNearestDepth(planarWaterDepth,uv),f32(textureDimensions(planarWaterDepth).y));
 let level=margoConeLevel(max(sqrt(sqrt(2.0*planarWaterVariance)),planarWater.settings.w),planarWaterRay.x,planarWaterRay.y,f32(textureNumLevels(planarWaterImage)-1));
 let blur=exp2(level)-1.0;`;
const declarations = (binding: number, cone: boolean) => {
  const code = `
struct PlanarWaterFrame { projection:mat4x4f, settings:vec4f, tint:vec4f }
@group(0) @binding(${binding}) var<uniform> planarWater:PlanarWaterFrame;
@group(0) @binding(${binding + 1}) var planarWaterImage:texture_2d<f32>;
@group(0) @binding(${binding + 2}) var planarWaterSampler:sampler;
var<private> planarWaterWorld:vec3f;
fn skyColor(direction:vec3f,rough:f32)->vec3f {
 let fallback=skyColorBase(direction,rough);
 // A capture from above the mean plane is unusable after the camera goes under it.
 if(planarWater.settings.x<0.5||frame.eye.y<=frame.settings.y){return fallback;}
 let clip=planarWater.projection*vec4f(planarWaterWorld,1);
 if(clip.w<=0.000001){return fallback;}
 let incident=normalize(planarWaterWorld-frame.eye.xyz);
 let calm=reflect(incident,vec3f(0,1,0));
 // Project the difference from a flat mirror into the capture's own view, so calm water never slides the image.
 let bend=planarWater.projection*vec4f(direction-calm,0);
 let uv=(clip.xy/clip.w+bend.xy*planarWater.settings.z)*vec2f(0.5,-0.5)+0.5;
 let edge=min(uv,1.0-uv);
 if(any(edge<=vec2f(0))){return fallback;}
 let texel=1.0/vec2f(textureDimensions(planarWaterImage));
 let blur=planarWater.settings.w*(8.0+16.0*rough*rough);
 let offset=texel*blur;
 // A plane capture has no local geometry at the infinite ocean horizon. Feather its contribution over the
 // capture filter's vertical footprint in angular units to keep the procedural or HDR sky continuous there.
 let angularTexel=texel.y*2.0/length(vec3f(planarWater.projection[0].y,planarWater.projection[1].y,planarWater.projection[2].y));
 let horizon=smoothstep(0.0,angularTexel*max(3.0,blur),calm.y);
 // A finite capture has no information outside its rectangle: hand off to the sky across the filter footprint and the
 // maximum wave offset, so the capture's border never shows as it moves with the waves.
 let fade=smoothstep(vec2f(0),max(texel*max(3.0,blur),vec2f(planarWater.settings.z)),edge);
 var color=textureSampleLevel(planarWaterImage,planarWaterSampler,uv,0).rgb;
 if(blur>0.0){
  color=color*0.5+(textureSampleLevel(planarWaterImage,planarWaterSampler,uv+vec2f(offset.x,0),0).rgb+textureSampleLevel(planarWaterImage,planarWaterSampler,uv-vec2f(offset.x,0),0).rgb+textureSampleLevel(planarWaterImage,planarWaterSampler,uv+vec2f(0,offset.y),0).rgb+textureSampleLevel(planarWaterImage,planarWaterSampler,uv-vec2f(0,offset.y),0).rgb)*0.125;
 }
 return mix(fallback,color*planarWater.tint.rgb,planarWater.settings.y*fade.x*fade.y*horizon);
}
`;
  if (!cone) return code;
  const flat = ' let blur=planarWater.settings.w*(8.0+16.0*rough*rough);',
    sample = 'var color=textureSampleLevel(planarWaterImage,planarWaterSampler,uv,0).rgb;\n if(blur>0.0){';
  if (!code.includes(flat) || !code.includes(sample))
    throw fault('failed', 'WaterReflection found no blur lines to replace; rebuild @margoengine/water');
  return (
    reflectionConeShader +
    code
      .replace(
        'var planarWaterSampler:sampler;',
        `var planarWaterSampler:sampler;\n@group(0) @binding(${binding + 3}) var planarWaterDepth:texture_depth_2d;\nvar<private> planarWaterVariance:f32;`,
      )
      .replace(flat, ' ' + coneBlur)
      .replace(sample, 'var color=textureSampleLevel(planarWaterImage,planarWaterSampler,uv,level).rgb;\n if(false){')
  );
};

/** Project environment's planar capture into Water's existing Fresnel term, including its SSR capture. */
export class WaterReflection implements EnginePlugin {
  readonly name = `water:reflection-${sequence++}`;
  private readonly surface: Water;
  private readonly source: WaterPlanarCapture;
  private readonly values = new Float32Array(24);
  private readonly cone: boolean;
  private fallbackDepth?: GPUTexture;
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
    if (options.contactHardening !== undefined && typeof options.contactHardening !== 'boolean')
      throw rangeError('Invalid water reflection contactHardening; pass true or false', 'material');
    this.cone = options.contactHardening ?? false;
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
    if (surfaceEffects.get(this.surface)?.some((e) => e.key.startsWith('reflector')))
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
    if (this.cone)
      this.fallbackDepth = device.createTexture({
        size: [1, 1],
        format: 'depth32float',
        usage: GPUTextureUsage.TEXTURE_BINDING,
      });
    this.sampler = device.createSampler({
      minFilter: 'linear',
      magFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.remove = addSurfaceEffect(this.surface, {
      // The key is part of Water's pipeline key: the contact-hardening shader binds one more texture.
      key: this.cone ? 'reflector-cone' : 'reflector',
      vertex: false,
      count: this.cone ? 4 : 3,
      shader: (code, binding) => {
        if (this.cone && !code.includes(variance))
          throw fault('failed', 'WaterReflection found no normal variance line; rebuild @margoengine/water');
        return code
          .replace(
            'fn skyColor(direction:vec3f,rough:f32)->vec3f {return skyColorBase(direction,rough);}',
            declarations(binding, this.cone),
          )
          .replace(
            '@fragment fn fragment(i:Output)->Result{',
            '@fragment fn fragment(i:Output)->Result{\nplanarWaterWorld=i.world;',
          )
          .replace(variance, this.cone ? `${variance}planarWaterVariance=variance;` : variance);
      },
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
    const image = (texture && this.cone ? this.source.blurTexture : undefined) ?? texture ?? this.fallback!;
    if (!this.cone) return [this.uniformResource!, this.view(image), this.sampler!];
    const depth = (texture ? this.source.depthTexture : undefined) ?? this.fallbackDepth!;
    return [this.uniformResource!, this.view(image), this.sampler!, this.view(depth, 'depth-only')];
  }
  private view(texture: GPUTexture, aspect?: GPUTextureAspect): GPUTextureView {
    let view = this.views.get(texture);
    if (!view) {
      view = texture.createView(aspect ? { aspect } : undefined);
      this.views.set(texture, view);
    }
    return view;
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
    this.fallbackDepth?.destroy();
    this.uniform = undefined;
    this.fallback = this.fallbackDepth = undefined;
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
