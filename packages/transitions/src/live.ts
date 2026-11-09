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
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** Cameras borrowed for the two scenes. Neither camera nor scene is disposed by the transition. */
export interface LiveTransitionOptions {
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
const shader =
  fullscreen +
  `
@group(0) @binding(0) var<uniform> progress:vec4f;
@group(0) @binding(1) var before:texture_2d<f32>;
@group(0) @binding(2) var after:texture_2d<f32>;
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let size=vec2i(textureDimensions(before));
 let q=clamp(vec2i(i.uv*vec2f(size)),vec2i(0),size-1);
 let a=textureLoad(before,q,0);let b=textureLoad(after,q,0);
 if(progress.x<=0.0){return a;}if(progress.x>=1.0){return b;}
 return mix(a,b,progress.x);
}`;
/** Renders two live scenes every frame, then cross-fades their resolved RGBA8 images. WebGPU only. */
export class LiveTransitions implements EnginePlugin {
  readonly name = 'transitions:live';
  private output?: Scene;
  private images: GPUTexture[] = [];
  private uniform?: GPUBuffer;
  private pipeline?: GPURenderPipeline;
  private bind?: GPUBindGroup;
  private format?: GPUTextureFormat;
  private samples = 0;
  private elapsed = 1;
  private duration = 1;
  private disposed = false;
  private readonly values = new Float32Array(4);
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
  /** Restarts the cross-fade, duration finite (0,60] seconds. Default 1. */
  start(seconds = 1): void {
    this.live();
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60)
      throw new RangeError('Live transition seconds must be finite in (0,60]; check the duration');
    this.duration = seconds;
    this.elapsed = 0;
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
        this.images.includes(target))
    )
      throw new TypeError(
        'Live transition target must be a separate single-sample 2D render attachment; create an output texture',
      );
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
          this.pipeline = render(c.device, shader, c.format, { multisample: { count: samples } });
          this.format = c.format;
          this.samples = samples;
          this.bind = undefined;
        }
        this.bind ??= group(c.device, this.pipeline, [
          { buffer: this.uniform! },
          this.images[0]!.createView(),
          this.images[1]!.createView(),
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
    this.uniform = undefined;
    this.pipeline = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
