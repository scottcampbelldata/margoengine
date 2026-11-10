/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph } from '@margoengine/core/extension';
import { group, render, draw } from '../../shared/gpu.js';
import { SceneTarget } from '../../shared/msaa.js';
import { MargoError } from '@margoengine/math/errors';
import { kinds, shader } from './builtin.js';
import { floatOutput } from './formats.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: {
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
  COPY_SRC: number;
  COPY_DST: number;
};
/**
 * How `start()` reveals the new scene over the frozen frame: `'wipe'` left to right, `'dissolve'` per-pixel random,
 * `'radial'` a clockwise sweep around the centre, `'chromatic'` a cross-fade with red/blue split by `displacement`.
 */
export type TransitionKind = 'wipe' | 'dissolve' | 'radial' | 'chromatic';
/**
 * start() freezes the last rendered frame while the scene underneath changes. WebGPU only.
 * @throws RangeError from `start` for an unknown kind, `seconds` outside (0, 60] or `displacement` outside 0-0.25.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`.
 */
export class Transitions implements EnginePlugin {
  readonly name: string = 'transitions';
  /** Nest optional captures inside the built-in capture and composite them in reverse order. */
  protected readonly captureLayer: number = 0;
  /** Shader source supplied by optional transition entries. */
  protected shaderCode: string = shader;
  /** Image bindings used by optional entries; images remain owned by the capture. */
  protected transitionBindings(before: GPUTexture, after: GPUTexture): GPUBindingResource[] {
    return [{ buffer: this.uniform! }, before.createView(), after.createView()];
  }
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
    if (this.disposed) throw new MargoError('disposed', 'Transitions is disposed; create a new Transitions');
    if (
      !kinds.includes(kind) ||
      !Number.isFinite(seconds) ||
      seconds <= 0 ||
      seconds > 60 ||
      !Number.isFinite(displacement) ||
      displacement < 0 ||
      displacement > 0.25
    )
      throw new RangeError(
        'Transition needs a known kind, seconds up to 60 and displacement up to 0.25; check the arguments.',
      );
    this.duration = seconds;
    this.elapsed = 0;
    this.values[1] = kinds.indexOf(kind);
    this.values[2] = displacement;
    this.request = true;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Transitions requires WebGPU; attach a new Transitions to a WebGPU engine; see https://margoengine.com/errors#unsupported',
      );
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: `${this.name}:capture`,
      order: -80 + this.captureLayer,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        if (!floatOutput(c.format, c.descriptor.multisample?.count ?? 1))
          throw new TypeError(
            'Transitions need a float color render attachment with MSAA resolve support; choose rgba8unorm',
          );
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
          this.pipeline = render(c.device, this.shaderCode, c.format, { multisample: c.descriptor.multisample });
          this.bind = group(c.device, this.pipeline, this.transitionBindings(this.previous, this.scene));
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
            this.bind = group(c.device, this.pipeline!, this.transitionBindings(this.previous, this.scene!));
          }
          c.encoder.copyTextureToTexture({ texture: this.scene! }, { texture: this.previous! }, [c.width, c.height]);
          this.request = false;
        }
        this.capture!.begin(c);
      },
    });
    graph.add({
      name: `${this.name}:blend`,
      order: 50 - this.captureLayer,
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
    this.elapsed = this.duration;
    this.request = false;
    this.setup(engine);
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
