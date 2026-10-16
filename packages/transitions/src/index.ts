/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph } from '@margoengine/core/extension';
import { fullscreen, group, render, draw } from '../../shared/gpu.js';
import { SceneTarget } from '../../shared/msaa.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: {
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
  COPY_SRC: number;
  COPY_DST: number;
};
export type TransitionKind = 'wipe' | 'dissolve' | 'radial' | 'chromatic';
const kinds = ['wipe', 'dissolve', 'radial', 'chromatic'];
const shader =
  fullscreen +
  `
@group(0) @binding(0) var<uniform> settings:vec4f;
@group(0) @binding(1) var before:texture_2d<f32>;
@group(0) @binding(2) var after:texture_2d<f32>;
fn sample(t:texture_2d<f32>,uv:vec2f)->vec4f {let size=vec2i(textureDimensions(t));return textureLoad(t,clamp(vec2i(uv*vec2f(size)),vec2i(0),size-1),0);}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let p=settings.x;if(p<=0.0){return sample(before,i.uv);}if(p>=1.0){return sample(after,i.uv);}
 var edge=i.uv.x;
 if(settings.y==1.0){edge=fract(sin(dot(floor(i.uv*vec2f(textureDimensions(after))),vec2f(12.9898,78.233)))*43758.5453);}
 if(settings.y==2.0){edge=fract(atan2(i.uv.x-0.5,0.5-i.uv.y)/6.2831853+1.0);}
 if(settings.y==3.0){let shift=vec2f(sin(p*3.14159265)*settings.z,0);let a=sample(after,i.uv+shift);let b=sample(after,i.uv-shift);return mix(sample(before,i.uv),vec4f(a.r,sample(after,i.uv).g,b.b,1),p);}
 return mix(sample(before,i.uv),sample(after,i.uv),1.0-smoothstep(p-0.01,p+0.01,edge));
}`;
/** start() freezes the last rendered frame while the scene underneath changes. */
export class Transitions implements EnginePlugin {
  readonly name = 'transitions';
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private scene?: GPUTexture;
  private previous?: GPUTexture;
  private pipeline?: GPURenderPipeline;
  private bind?: GPUBindGroup;
  private capture?: SceneTarget;
  private depth?: GPUTexture;
  private format?: GPUTextureFormat;
  private request = false;
  private duration = 1;
  private elapsed = 1;
  private readonly values = new Float32Array([1, 0, 0.02, 0]);
  private disposed = false;
  constructor() {}
  static attach(engine: EngineKernel): Transitions {
    const effect = new Transitions();
    engineRuntime(engine).use(effect);
    return effect;
  }
  get progress(): number {
    return Math.min(1, this.elapsed / this.duration);
  }
  start(kind: TransitionKind = 'wipe', seconds = 1, displacement = 0.02): void {
    if (this.disposed) throw new Error('Transitions is disposed');
    if (
      !kinds.includes(kind) ||
      !Number.isFinite(seconds) ||
      seconds <= 0 ||
      seconds > 60 ||
      !Number.isFinite(displacement) ||
      displacement < 0 ||
      displacement > 0.25
    )
      throw new RangeError('Invalid transition');
    this.duration = seconds;
    this.elapsed = 0;
    this.values[1] = kinds.indexOf(kind);
    this.values[2] = displacement;
    this.request = true;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu) throw new Error('Transitions requires WebGPU');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'transitions:capture',
      order: -80,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        if (
          this.scene?.width !== c.width ||
          this.scene?.height !== c.height ||
          this.format !== c.format ||
          this.depth?.format !== c.descriptor.depthStencil!.format ||
          this.capture?.samples !== (c.descriptor.multisample?.count ?? 1)
        ) {
          const frozen = this.request ? this.scene : this.elapsed < this.duration ? this.previous : undefined;
          this.capture?.dispose();
          this.depth?.destroy();
          if (this.scene !== frozen) this.scene?.destroy();
          if (this.previous !== frozen) this.previous?.destroy();
          this.format = c.format;
          this.scene = c.device.createTexture({
            size: [c.width, c.height],
            format: c.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
          });
          this.previous =
            frozen ??
            c.device.createTexture({
              size: [c.width, c.height],
              format: c.format,
              usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
          this.depth = c.device.createTexture({
            size: [c.width, c.height],
            format: c.descriptor.depthStencil!.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          });
          this.capture = new SceneTarget(c.device, this.scene, this.depth, c.descriptor.multisample?.count ?? 1);
          this.pipeline = render(c.device, shader, c.format, { multisample: c.descriptor.multisample });
          this.bind = group(c.device, this.pipeline, [
            { buffer: this.uniform! },
            this.previous.createView(),
            this.scene.createView(),
          ]);
          this.request = false;
        }
        if (this.request) {
          if (
            this.previous!.width !== c.width ||
            this.previous!.height !== c.height ||
            this.previous!.format !== c.format ||
            !(this.previous!.usage & GPUTextureUsage.COPY_DST)
          ) {
            this.previous!.destroy();
            this.previous = c.device.createTexture({
              size: [c.width, c.height],
              format: c.format,
              usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            this.bind = group(c.device, this.pipeline!, [
              { buffer: this.uniform! },
              this.previous.createView(),
              this.scene!.createView(),
            ]);
          }
          c.encoder.copyTextureToTexture({ texture: this.scene! }, { texture: this.previous! }, [c.width, c.height]);
          this.request = false;
        }
        this.capture!.begin(c);
      },
    });
    graph.add({
      name: 'transitions:blend',
      order: 50,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        this.elapsed = Math.min(this.duration, this.elapsed + c.delta);
        this.values[0] = this.progress;
        c.device.queue.writeBuffer(this.uniform!, 0, this.values as Float32Array<ArrayBuffer>);
        this.capture!.resolve(c.encoder, true);
        this.capture!.restore(c);
        draw(c, this.pipeline!, this.bind!, 'clear');
      },
    });
  }
  private release(): void {
    this.capture?.dispose();
    this.depth?.destroy();
    this.capture = undefined;
    this.depth = undefined;
    this.uniform?.destroy();
    this.scene?.destroy();
    this.previous?.destroy();
    this.uniform = this.scene = this.previous = undefined;
    this.pipeline = this.bind = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
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
