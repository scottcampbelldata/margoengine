/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Scene, Camera } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type Scene as RuntimeScene,
  Camera as RuntimeCamera,
} from '@margoengine/core/extension';
import { fullscreen, render, group, draw } from '../../shared/gpu.js';
import { fault } from '../../shared/errors.js';
import { kinds, shader as builtinShader } from './builtin.js';
import { customCode } from './custom-code.js';
import type { TransitionKind } from './index.js';
import { floatOutput } from './formats.js';
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_DST: number };
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** Cameras borrowed for the two scenes. Neither camera nor scene is disposed by the transition. */
export interface LiveTransitionOptions {
  /** Initial built-in kind. Default crossfade. Use start(kind, seconds) to select another. */
  kind?: TransitionKind | 'crossfade';
  /** Optional greyscale mask. ImageData is copied; keep a borrowed ImageBitmap open through disposal. */
  mask?: ImageData | ImageBitmap;
  /** Mask threshold half-width. Default 0.02; zero is a hard edge, otherwise 0.000001..1. */
  softness?: number;
  /** Outgoing camera. Default engine.camera. */
  beforeCamera?: Camera;
  /** Incoming camera. Default engine.camera. */
  afterCamera?: Camera;
}
/** One explicit frame of both scenes and their cross-fade. */
export interface LiveTransitionFrame {
  /** Seconds to advance each scene and progress, finite 0..1. Default 0. */
  delta?: number;
  /** Optional borrowed single-sample output texture. Default full canvas. */
  target?: GPUTexture;
  /** Scene frustum culling. Default true. */
  culling?: boolean;
}
/** Renders two live scenes every frame, then composites their resolved RGBA8 images. WebGPU only. */
export class LiveTransitions implements EnginePlugin {
  readonly name = 'transitions:live';
  private output?: Scene;
  private code = builtinShader;
  private mask?: GPUTexture;
  private maskSource?: { width: number; height: number; data: Uint8ClampedArray } | ImageBitmap;
  private images: GPUTexture[] = [];
  private uniform?: GPUBuffer;
  private pipeline?: GPURenderPipeline;
  private bind?: GPUBindGroup;
  private format?: GPUTextureFormat;
  private samples = 0;
  private elapsed = 1;
  private duration = 1;
  private disposed = false;
  private readonly values = new Float32Array([1, 4, 0.02, 0]);
  private constructor(
    private readonly engine: Engine,
    private readonly before: Scene,
    private readonly after: Scene,
    private readonly options: LiveTransitionOptions,
  ) {}
  /** Attaches an owned composite scene. Pass two distinct live scenes from this engine. */
  static attach(
    engine: EngineKernel,
    before: Scene,
    after: Scene,
    options: LiveTransitionOptions = {},
  ): LiveTransitions {
    const runtime = engineRuntime(engine);
    if (!runtime.gpu) throw fault('unsupported', 'Live transitions require WebGPU; select a WebGPU engine');
    if (runtime.disposed) throw fault('disposed', 'Engine is disposed; create a new engine');
    if (before === after || !runtime.scenes.has(before as RuntimeScene) || !runtime.scenes.has(after as RuntimeScene))
      throw new TypeError('Live transitions need two distinct live scenes from this engine; use engine.createScene()');
    if (
      (options.beforeCamera && !(options.beforeCamera instanceof RuntimeCamera)) ||
      (options.afterCamera && !(options.afterCamera instanceof RuntimeCamera))
    )
      throw new TypeError('Live transition cameras must be Camera instances; use engine.camera or new Camera()');
    const effect = new LiveTransitions(runtime, before, after, { ...options });
    const kind = options.kind ?? 'crossfade';
    if (kind !== 'crossfade' && !kinds.includes(kind))
      throw new RangeError('Unknown live transition kind; choose wipe, dissolve, radial, chromatic or crossfade');
    effect.values[1] = kind === 'crossfade' ? 4 : kinds.indexOf(kind);
    if (options.mask) effect.configureMask(options.mask, options.softness ?? 0.02);
    effect.output = engine.createScene('transitions:live');
    try {
      effect.output.use(effect);
    } catch (error) {
      effect.dispose();
      throw error;
    }
    return effect;
  }
  get progress(): number {
    return Math.min(1, this.elapsed / this.duration);
  }
  /** Restarts the current kind; duration defaults to 1 second, finite (0,60]. */
  start(seconds?: number): void;
  /** Selects a built-in kind. Displacement defaults to 0.02, finite 0..0.25. Masks and custom shaders ignore kind. */
  start(kind: TransitionKind | 'crossfade', seconds?: number, displacement?: number): void;
  start(kindOrSeconds: TransitionKind | 'crossfade' | number = 1, seconds = 1, displacement = 0.02): void {
    this.live();
    const kind =
      typeof kindOrSeconds === 'number'
        ? this.values[1]!
        : kindOrSeconds === 'crossfade'
          ? 4
          : kinds.indexOf(kindOrSeconds);
    const duration = typeof kindOrSeconds === 'number' ? kindOrSeconds : seconds;
    if (
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 60 ||
      kind < 0 ||
      !Number.isFinite(displacement) ||
      displacement < 0 ||
      displacement > 0.25
    )
      throw new RangeError(
        'Live transition needs a known kind, seconds in (0,60] and displacement in [0,0.25]; check start arguments',
      );
    this.duration = duration;
    this.elapsed = 0;
    this.values[1] = kind;
    this.values[2] = displacement;
  }
  private configureMask(image: ImageData | ImageBitmap, softness: number): void {
    const data = typeof ImageData !== 'undefined' && image instanceof ImageData;
    const bitmap = typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap;
    if ((!data && !bitmap) || (data && !(image.data instanceof Uint8ClampedArray)))
      throw new TypeError('Live mask needs 8-bit ImageData or an open ImageBitmap; decode the image first');
    const limit = Math.min(4096, this.engine.gpu!.limits.maxTextureDimension2D);
    if (![image.width, image.height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= limit))
      throw new RangeError('Live mask dimensions exceed device limits; use an image of 1..min(4096, device limit)');
    if (!Number.isFinite(softness) || softness < 0 || softness > 1 || (softness > 0 && softness < 0.000001))
      throw new RangeError('Live mask softness is out of range; use zero or 0.000001..1');
    this.maskSource = data ? { width: image.width, height: image.height, data: image.data.slice() } : image;
    this.code = `${fullscreen}
@group(0) @binding(0) var<uniform> settings:vec4f;
@group(0) @binding(1) var before:texture_2d<f32>;
@group(0) @binding(2) var after:texture_2d<f32>;
@group(0) @binding(3) var mask:texture_2d<f32>;
fn sample(t:texture_2d<f32>,pixel:vec2u,extent:vec2u)->vec4f {
 let n=textureDimensions(t);let q=(pixel*n+n/2u)/extent;
 return textureLoad(t,vec2i(min(q,n-1u)),0);
}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let p=settings.x;let pixel=vec2u(i.position.xy);let extent=textureDimensions(after);
 if(p<=0.0){return sample(before,pixel,extent);}if(p>=1.0){return sample(after,pixel,extent);}
 let edge=sample(mask,pixel,extent).r;
 let weight=${softness === 0 ? 'select(0.0,1.0,edge<=p)' : `1.0-smoothstep(p-f32(${softness}),p+f32(${softness}),edge)`};
 return mix(sample(before,pixel,extent),sample(after,pixel,extent),weight);
}`;
  }
  /** Validates trusted WGSL before attaching. Same transition function and sample helper as the custom entry. */
  static async custom(
    engine: EngineKernel,
    before: Scene,
    after: Scene,
    wgsl: string,
    options: Omit<LiveTransitionOptions, 'mask' | 'softness' | 'kind'> & { signal?: AbortSignal } = {},
  ): Promise<LiveTransitions> {
    const code = await customCode(engine, wgsl, options.signal);
    const effect = LiveTransitions.attach(engine, before, after, options);
    effect.code = code;
    return effect;
  }
  private live(): void {
    if (this.disposed || this.engine.disposed) throw fault('disposed', 'Live transition is disposed; attach a new one');
  }
  /** Draws both scenes once and then the composite. Use this instead of engine.render for transition frames. */
  render({ delta = 0, target, culling = true }: LiveTransitionFrame = {}): void {
    this.live();
    if (!Number.isFinite(delta) || delta < 0 || delta > 1)
      throw new RangeError('Live transition delta must be finite in [0,1]; pass seconds');
    const device = this.engine.gpu;
    if (!device) throw fault('state', 'Live transition device is unavailable; wait for engine recovery');
    if (!this.engine.scenes.has(this.before as RuntimeScene) || !this.engine.scenes.has(this.after as RuntimeScene))
      throw fault('state', 'A live transition scene was disposed; attach two live scenes');
    const width = target?.width ?? this.engine.canvas.width;
    const height = target?.height ?? this.engine.canvas.height;
    if (![width, height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= device.limits.maxTextureDimension2D))
      throw new RangeError('Live transition dimensions must fit the device texture limit; resize the output');
    if (
      target &&
      (!(target.usage & GPUTextureUsage.RENDER_ATTACHMENT) ||
        target.sampleCount !== 1 ||
        target.dimension !== '2d' ||
        target.depthOrArrayLayers !== 1 ||
        !floatOutput(target.format, this.engine.renderTarget?.samples ?? 1) ||
        this.images.includes(target))
    )
      throw new TypeError(
        'Live transition target must be a separate single-sample 2D float color render attachment with MSAA resolve support; choose rgba8unorm',
      );
    if (this.maskSource && Math.max(width, height) > 65535)
      throw new RangeError('Live mask captures exceed integer addressing limits; use dimensions at most 65535');
    if (this.images[0]?.width !== width || this.images[0]?.height !== height) {
      this.releaseImages();
      try {
        for (let i = 0; i < 2; i++)
          this.images.push(
            device.createTexture({
              size: [width, height],
              format: 'rgba8unorm',
              usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            }),
          );
      } catch (error) {
        this.releaseImages();
        throw error;
      }
    }
    this.engine.render({
      delta,
      culling,
      views: [
        {
          scene: this.before as RuntimeScene,
          camera: this.options.beforeCamera ?? this.engine.camera,
          viewport: [0, 0, 1, 1],
          target: { color: this.images[0]! },
        },
        {
          scene: this.after as RuntimeScene,
          camera: this.options.afterCamera ?? this.engine.camera,
          viewport: [0, 0, 1, 1],
          target: { color: this.images[1]! },
        },
        {
          scene: this.output as RuntimeScene,
          camera: this.engine.camera,
          viewport: [0, 0, 1, 1],
          target: target ? { color: target } : undefined,
        },
      ],
    });
  }
  setup(engine: Engine): void {
    const source = this.maskSource;
    if (source) {
      if (source.width < 1 || source.height < 1)
        throw fault('state', 'Live mask bitmap is closed; keep it open until transition disposal');
      this.mask = engine.gpu!.createTexture({
        size: [source.width, source.height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      if ('data' in source)
        engine.gpu!.queue.writeTexture(
          { texture: this.mask },
          source.data as Uint8ClampedArray<ArrayBuffer>,
          { bytesPerRow: source.width * 4 },
          [source.width, source.height],
        );
      else
        engine.gpu!.queue.copyExternalImageToTexture({ source }, { texture: this.mask }, [source.width, source.height]);
    }
    this.uniform = engine.gpu!.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: 50,
      execute: (c) => {
        if (c.backend !== 'webgpu' || !this.images.length) return;
        const samples = c.descriptor.multisample?.count ?? 1;
        if (!this.pipeline || this.format !== c.format || this.samples !== samples) {
          this.pipeline = render(c.device, this.code, c.format, { multisample: { count: samples } });
          this.format = c.format;
          this.samples = samples;
          this.bind = undefined;
        }
        this.bind ??= group(c.device, this.pipeline, [
          { buffer: this.uniform! },
          this.images[0]!.createView(),
          this.images[1]!.createView(),
          ...(this.mask ? [this.mask.createView()] : []),
        ]);
        this.elapsed = Math.min(this.duration, this.elapsed + c.delta);
        this.values[0] = this.progress;
        c.device.queue.writeBuffer(this.uniform!, 0, this.values as Float32Array<ArrayBuffer>);
        draw(c, this.pipeline, this.bind, 'clear');
      },
    });
  }
  private releaseImages(): void {
    for (const image of this.images) image.destroy();
    this.images = [];
    this.bind = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.releaseImages();
    this.uniform?.destroy();
    this.mask?.destroy();
    this.mask = undefined;
    this.pipeline = undefined;
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine.sceneOf(this)?.removePlugin(this.name);
    this.output?.dispose();
    this.output = undefined;
    this.releaseImages();
    this.uniform?.destroy();
    this.mask?.destroy();
    this.mask = undefined;
    this.maskSource = undefined;
    this.uniform = undefined;
    this.pipeline = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
