/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';

declare const GPUTextureUsage: { RENDER_ATTACHMENT: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/**
 * Opt-in portable stencil attachment for the scene. Existing stencil targets are borrowed; otherwise the scene uses
 * depth24plus-stencil8 with its current dimensions and sample count. Core's main draw clears stencil to zero each frame.
 * Stencil belongs to its attachment: captures and MSAA resolves copy depth only, so masks do not cross target boundaries.
 * Explicit offscreen renderers and XR targets must provide their own stencil attachments.
 */
export class StencilBuffer implements EnginePlugin {
  readonly name = 'materials:stencil-buffer';
  private engine?: Engine;
  private device?: GPUDevice;
  private texture?: GPUTexture;
  private view?: GPUTextureView;
  private base?: GPURenderPipelineDescriptor;
  private descriptor?: GPURenderPipelineDescriptor;
  private frame?: { context: Context; depth: GPUTextureView; descriptor: GPURenderPipelineDescriptor };
  private disposed = false;

  /** Attach a portable scene stencil buffer to a WebGPU engine. */
  static attach(engine: EngineKernel): StencilBuffer {
    const value = new StencilBuffer();
    engineRuntime(engine).use(value);
    return value;
  }

  /** Bind the plugin to its owning WebGPU engine; called by engine.use. */
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'StencilBuffer is disposed; create a new StencilBuffer');
    if (!engine.gpu) throw new MargoError('unsupported', 'StencilBuffer requires WebGPU; use a WebGPU engine');
    if (this.engine && this.engine !== engine)
      throw new MargoError(
        'attached',
        'StencilBuffer already belongs to another engine; create a new StencilBuffer for this engine',
      );
    this.engine = engine;
  }

  /** Register attachment promotion before scene captures and restoration after scene rendering. */
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name + ':begin',
      order: -110,
      execute: (c) => {
        if (c.backend === 'webgpu') this.begin(c);
      },
    });
    graph.add({
      name: this.name + ':restore',
      order: 10001,
      execute: (c) => {
        if (c.backend === 'webgpu') this.restore(c);
      },
    });
  }

  private begin(c: Context): void {
    // A failed graph may skip its final pass. Restore only if its attachment is still current: core resets the same
    // context object at the next frame, and those fresh renderer views must never be replaced by the failed frame's views.
    this.restore();
    if (c.descriptor.depthStencil!.format.includes('stencil')) return;
    const samples = c.descriptor.multisample?.count ?? 1;
    if (samples !== 1 && samples !== 4)
      throw new RangeError('StencilBuffer sample count is invalid; set the scene sample count to 1 or 4');
    if (
      !Number.isSafeInteger(c.width) ||
      !Number.isSafeInteger(c.height) ||
      Math.min(c.width, c.height) < 1 ||
      Math.max(c.width, c.height) > c.device.limits.maxTextureDimension2D
    )
      throw new RangeError(
        'StencilBuffer dimensions are invalid; use positive integers within the device texture dimension limit',
      );
    if (
      this.device !== c.device ||
      this.texture?.width !== c.width ||
      this.texture.height !== c.height ||
      this.texture.sampleCount !== samples
    ) {
      const texture = c.device.createTexture({
        size: [c.width, c.height],
        format: 'depth24plus-stencil8',
        sampleCount: samples,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      let view: GPUTextureView;
      try {
        view = texture.createView();
      } catch (error) {
        texture.destroy();
        throw error;
      }
      this.texture?.destroy();
      this.texture = texture;
      this.view = view;
      this.device = c.device;
    }
    if (this.base !== c.descriptor) {
      this.base = c.descriptor;
      this.descriptor = {
        ...c.descriptor,
        depthStencil: { ...c.descriptor.depthStencil!, format: 'depth24plus-stencil8' },
      };
    }
    this.frame = { context: c, depth: c.depth, descriptor: c.descriptor };
    c.depth = this.view!;
    c.descriptor = this.descriptor!;
  }

  private restore(c?: Context): void {
    const frame = this.frame;
    this.frame = undefined;
    if (
      frame &&
      (c === frame.context || (frame.context.depth === this.view && frame.context.descriptor === this.descriptor))
    ) {
      frame.context.depth = frame.depth;
      frame.context.descriptor = frame.descriptor;
    }
  }

  private release(): void {
    this.restore();
    this.texture?.destroy();
    this.texture = this.view = this.device = this.base = this.descriptor = undefined;
  }

  /** Release old device resources and rebind the plugin after engine device recovery. */
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }

  /** Detach the plugin, restore a borrowed attachment and free its owned depth texture. Safe to repeat. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.engine?.removePlugin(this.name);
    } finally {
      this.release();
      this.engine = undefined;
    }
  }

  /** Dispose the stencil buffer when leaving a using scope. */
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
