import type { EngineKernel } from '@margoengine/core';
import { fault } from '../../shared/errors.js';
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
export interface BakedTexture {
  /** TEXTURE_BINDING, STORAGE_BINDING and COPY_SRC usage. */
  readonly texture: GPUTexture;
  readonly width: number;
  readonly height: number;
  /** Destroy the texture and detach it from the baker. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}
/** A baker bound to one device. Create a new one after device replacement. */
export interface TextureBaker {
  /** Complete a compute bake; no CPU pixel loop or readback. */
  bake(options?: TextureBakeOptions): Promise<BakedTexture>;
  /** Destroy all retained outputs. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}
const patterns: TexturePattern[] = ['noise', 'bricks', 'tiles', 'wood', 'rust'];
const bounded = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;
const integer = (v: number, lo: number, hi: number) => Number.isInteger(v) && bounded(v, lo, hi);
const tuple = (v: unknown, count: number, lo: number, hi: number): v is number[] =>
  Array.isArray(v) && v.length === count && v.every((x) => bounded(x, lo, hi));
const lost = () =>
  fault('failed', 'Texture baker device was lost; create a baker on the replacement device', 'procedural');
async function wait<T>(work: Promise<T>, lifecycle: AbortSignal, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  lifecycle.throwIfAborted();
  const combined = signal ? AbortSignal.any([lifecycle, signal]) : lifecycle;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(combined.reason);
    combined.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    if (abort) combined.removeEventListener('abort', abort);
  }
}
class Baker implements TextureBaker {
  private outputs = new Set<BakedTexture>();
  private disposed = false;
  constructor(
    private device: GPUDevice,
    private pipeline: GPUComputePipeline,
    private lifecycle: AbortController,
  ) {}
  async bake(options: TextureBakeOptions = {}): Promise<BakedTexture> {
    if (this.disposed) throw fault('disposed', 'Texture baker is disposed; create a new baker', 'procedural');
    this.lifecycle.signal.throwIfAborted();
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw fault('failed', 'Texture bake options must be an object', 'procedural');
    options?.signal?.throwIfAborted();
    const {
      width = 256,
      height = 256,
      seed = 1,
      pattern = 'bricks',
      repeat = [4, 8],
      detail = 0.2,
      grout = 0.08,
      stagger = 0.5,
      color = [0.55, 0.2, 0.08],
      secondary = [0.15, 0.12, 0.1],
      offset = [0, 0],
      signal,
    } = options;
    const kind = patterns.indexOf(pattern),
      maximum = Math.min(2048, this.device.limits.maxTextureDimension2D);
    if (
      kind < 0 ||
      !integer(width, 16, maximum) ||
      !integer(height, 16, maximum) ||
      !integer(seed, 0, 0xffffffff) ||
      !tuple(repeat, 2, 1, 64) ||
      !repeat.every(Number.isInteger) ||
      (kind === 1 && repeat[1] % 2 !== 0) ||
      !bounded(detail, 0, 1) ||
      !bounded(grout, 0, 0.45) ||
      !bounded(stagger, 0, 1) ||
      !tuple(color, 3, 0, 1) ||
      !tuple(secondary, 3, 0, 1) ||
      !tuple(offset, 2, -1024, 1024)
    )
      throw fault(
        'failed',
        'Invalid texture bake settings; use bounded dimensions, colours and integer repeats (even brick rows)',
        'procedural',
      );
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
      const output: BakedTexture = {
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
/** Compile one compute pipeline on a WebGPU engine/device; native WebGL2 rejects with a linked unsupported error. */
export async function createTextureBaker(
  source: GPUDevice | Pick<EngineKernel, 'backend' | 'gpu'>,
  options: { signal?: AbortSignal } = {},
): Promise<TextureBaker> {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw fault('failed', 'Texture factory options must be an object', 'procedural');
  options.signal?.throwIfAborted();
  if (!source || typeof source !== 'object')
    throw fault('unsupported', 'Texture baking requires a WebGPU device or engine', 'procedural');
  const device = source && ('backend' in source ? source.gpu : source);
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
