import type { EngineKernel } from '@margoengine/core';
import { fault } from '../../shared/errors.js';
import { textureSettings } from './texture-settings.js';
import { textureShader } from './texture-shader.js';

/** Periodic procedural material pattern. */
export type TexturePattern = 'noise' | 'bricks' | 'tiles' | 'wood' | 'rust';
/** GPU bake settings; colours are linear RGB. */
export interface TextureBakeOptions {
  /** Default bricks. */
  pattern?: TexturePattern;
  /** Integer 16..2048, also limited by the device. Default 256. */
  width?: number;
  /** Integer 16..2048, also limited by the device. Default 256. */
  height?: number;
  /** Unsigned 32-bit integer. Default 1. */
  seed?: number;
  /** Integer repeats [columns, rows], 1..64; brick rows must be even. Default [4,8]. */
  repeat?: readonly [number, number];
  /** Detail strength 0..1. Default 0.2. */
  detail?: number;
  /** Mortar half width as fraction of a cell, 0..0.45. Default 0.08. */
  grout?: number;
  /** Alternate brick row offset, fraction 0..1. Ignored by other patterns. Default 0.5. */
  stagger?: number;
  /** Primary linear RGB, 0..1. Default [0.55,0.2,0.08]. */
  color?: readonly [number, number, number];
  /** Mortar/secondary linear RGB, 0..1. Default [0.15,0.12,0.1]. */
  secondary?: readonly [number, number, number];
  /** UV phase, finite within +/-1024; integer parts discarded. Default [0,0]. */
  offset?: readonly [number, number];
  /** Cancels the wait and releases an incomplete output. */
  signal?: AbortSignal;
}
/** Owned, repeat-sampled RGBA8 texture, with opaque alpha. */
export interface WebGPUBakedTexture {
  readonly backend: 'webgpu';
  /** TEXTURE_BINDING, STORAGE_BINDING and COPY_SRC usage. */
  readonly texture: GPUTexture;
  readonly width: number;
  readonly height: number;
  /** Destroy the texture and detach it from the baker. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}
/** Owned native WebGL2 texture on the source engine's context. */
export interface WebGLBakedTexture {
  readonly backend: 'webgl2';
  readonly texture: WebGLTexture;
  readonly gl: WebGL2RenderingContext;
  readonly width: number;
  readonly height: number;
  dispose(): void;
  [Symbol.dispose](): void;
}
/** Owned native texture handle, discriminated by its rendering backend. */
export type BakedTexture = WebGPUBakedTexture | WebGLBakedTexture;
/** A baker bound to one device. Create a new one after device replacement. */
export interface TextureBaker<T extends BakedTexture = BakedTexture> {
  /** Complete a compute (WebGPU) or fragment (WebGL2) bake; no CPU pixel loop or readback. */
  bake(options?: TextureBakeOptions): Promise<T>;
  /** Destroy all retained outputs. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}
const lost = () =>
  fault('failed', 'Texture baker device was lost; create a baker on the replacement device', 'procedural');
async function wait<T>(work: Promise<T>, lifecycle: AbortSignal, signal?: AbortSignal): Promise<T> {
  const outcome = work.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
  signal?.throwIfAborted();
  lifecycle.throwIfAborted();
  const combined = signal ? AbortSignal.any([lifecycle, signal]) : lifecycle;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(combined.reason);
    combined.addEventListener('abort', abort, { once: true });
  });
  try {
    const result = await Promise.race([outcome, cancelled]);
    signal?.throwIfAborted();
    lifecycle.throwIfAborted();
    if (!result.ok) throw result.error;
    return result.value;
  } finally {
    if (abort) combined.removeEventListener('abort', abort);
  }
}
class Baker implements TextureBaker<WebGPUBakedTexture> {
  private outputs = new Set<WebGPUBakedTexture>();
  private disposed = false;
  constructor(
    private device: GPUDevice,
    private pipeline: GPUComputePipeline,
    private lifecycle: AbortController,
  ) {}
  async bake(options: TextureBakeOptions = {}): Promise<WebGPUBakedTexture> {
    if (this.disposed) throw fault('disposed', 'Texture baker is disposed; create a new baker', 'procedural');
    this.lifecycle.signal.throwIfAborted();
    const { width, height, seed, repeat, detail, grout, stagger, color, secondary, offset, signal, kind } =
      textureSettings(options, this.device.limits.maxTextureDimension2D);
    const device = this.device,
      bytes = new ArrayBuffer(80),
      ints = new Uint32Array(bytes),
      floats = new Float32Array(bytes);
    ints.set([width, height, kind, seed]);
    floats.set([repeat[0], repeat[1], detail, grout], 4);
    floats.set([...color, 1, ...secondary, 1], 8);
    floats.set(
      offset.map((v) => ((v % 1) + 1) % 1),
      16,
    );
    floats[18] = stagger;
    // WebGPU specification flag values; avoids runtime globals in Node/SSR.
    let uniform: GPUBuffer | undefined, texture: GPUTexture | undefined;
    let complete = false;
    try {
      uniform = device.createBuffer({ size: 80, usage: 64 | 8 });
      texture = device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: 8 | 4 | 1 });
      device.queue.writeBuffer(uniform, 0, bytes);
      const group = device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: texture.createView() },
        ],
      });
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
      device.queue.submit([encoder.finish()]);
      await wait(device.queue.onSubmittedWorkDone(), this.lifecycle.signal, signal);
      if (this.disposed) throw fault('disposed', 'Texture baker was disposed during the bake', 'procedural');
      this.lifecycle.signal.throwIfAborted();
      signal?.throwIfAborted();
      const outputs = this.outputs,
        baked = texture;
      const output: WebGPUBakedTexture = {
        backend: 'webgpu',
        texture,
        width,
        height,
        dispose() {
          baked.destroy();
          outputs.delete(output);
        },
        [Symbol.dispose]() {
          this.dispose();
        },
      };
      outputs.add(output);
      complete = true;
      return output;
    } catch (error) {
      signal?.throwIfAborted();
      this.lifecycle.signal.throwIfAborted();
      if (error instanceof Error && error.name === 'MargoError') throw error;
      throw Object.assign(fault('failed', 'Texture bake could not complete', 'procedural'), { cause: error });
    } finally {
      uniform?.destroy();
      if (!complete) texture?.destroy();
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycle.abort(fault('disposed', 'Texture baker was disposed during the bake', 'procedural'));
    for (const output of this.outputs) output.dispose();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
/** Compile a compute pipeline on WebGPU or a fragment pipeline on a native WebGL2 engine. */
export function createTextureBaker(
  source: GPUDevice,
  options?: { signal?: AbortSignal },
): Promise<TextureBaker<WebGPUBakedTexture>>;
export function createTextureBaker(
  source: Pick<EngineKernel, 'backend' | 'gpu'> & Partial<Pick<EngineKernel, 'canvas'>>,
  options?: { signal?: AbortSignal },
): Promise<TextureBaker>;
export async function createTextureBaker(
  source: GPUDevice | (Pick<EngineKernel, 'backend' | 'gpu'> & Partial<Pick<EngineKernel, 'canvas'>>),
  options: { signal?: AbortSignal } = {},
): Promise<TextureBaker> {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw fault('failed', 'Texture factory options must be an object', 'procedural');
  options.signal?.throwIfAborted();
  if (!source || typeof source !== 'object')
    throw fault('unsupported', 'Texture baking requires a WebGPU device or engine', 'procedural');
  if ('backend' in source && source.backend === 'webgl2') {
    try {
      const gl = source.canvas?.getContext('webgl2');
      if (!gl)
        throw fault('unsupported', 'Texture baking needs the WebGL2 engine canvas or a WebGPU device', 'procedural');
      const { createWebGLBaker } = await import('./textures-webgl.js');
      options.signal?.throwIfAborted();
      return createWebGLBaker(gl);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof Error && error.name === 'MargoError') throw error;
      throw Object.assign(fault('failed', 'WebGL2 texture pipeline could not load or compile', 'procedural'), { cause: error });
    }
  }
  const device = 'backend' in source ? source.gpu : source;
  if (!device || ('backend' in source && source.backend !== 'webgpu'))
    throw fault('unsupported', 'Texture baking requires WebGPU compute; select the WebGPU backend', 'procedural');
  try {
    const lifecycle = new AbortController(),
      ref = new WeakRef(lifecycle);
    void device.lost.then(() => ref.deref()?.abort(lost()));
    const module = device.createShaderModule({ code: textureShader, label: '/packages/procedural/textures' });
    const compilation = await wait(module.getCompilationInfo(), lifecycle.signal, options.signal);
    const error = compilation.messages.find((message) => message.type === 'error');
    if (error) throw fault('failed', `Texture shader line ${error.lineNum}: ${error.message}`, 'procedural');
    const pipeline = await wait(
      device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
      }),
      lifecycle.signal,
      options.signal,
    );
    return new Baker(device, pipeline, lifecycle);
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof Error && error.name === 'MargoError') throw error;
    throw Object.assign(fault('failed', 'Texture compute pipeline could not compile', 'procedural'), { cause: error });
  }
}
