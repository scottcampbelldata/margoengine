import type { EngineKernel } from '@margoengine/core';
import { fault } from '../../shared/errors.js';
import { textureSettings } from './texture-settings.js';
import { pbrShader, pbrMipShader } from './textures-pbr-shader.js';
import type { TextureBakeOptions } from './textures.js';

/** Periodic material fields; all original /textures patterns plus marble, cloud, grass, fire, starfield and road. */
export type PBRTexturePattern =
  | 'noise'
  | 'bricks'
  | 'tiles'
  | 'wood'
  | 'rust'
  | 'marble'
  | 'cloud'
  | 'grass'
  | 'fire'
  | 'starfield'
  | 'road';
/** Shared material field, lighting-map and mipmap settings. Colours are linear RGB. */
export interface PBRTextureOptions extends Omit<TextureBakeOptions, 'pattern'> {
  /** Default bricks. */
  pattern?: PBRTexturePattern;
  /** Tangent-space normal multiplier, 0..8. Default 1. */
  normalStrength?: number;
  /** Height amplitude in units per UV tile, 0..1. Default 0.05. */
  heightScale?: number;
  /** Base perceptual roughness, 0..1. Default 0.7. */
  roughness?: number;
  /** Height-correlated roughness variation, 0..1. Default 0.3. */
  roughnessVariation?: number;
  /** Deterministic animation time in seconds, 0..1e6. Default 0. Rebake to animate cloud/fire/starfield. */
  time?: number;
  /** Complete chain down to 1x1, using area-filtered linear colour and renormalized normals. Default true. */
  mipmaps?: boolean;
}
/** Four owned GPU textures, usable on native WebGPU or the full WebGL2 compatibility device. */
export interface PBRTextureSet {
  readonly albedo: GPUTexture;
  /** RGB tangent-space XYZ in [0,1], +Y green and +Z facing outward. */
  readonly normal: GPUTexture;
  /** Identical RGB channels; glTF samples green. */
  readonly roughness: GPUTexture;
  /** Identical RGB channels, heightScale times the normalized field. */
  readonly height: GPUTexture;
  readonly width: number;
  readonly heightPixels: number;
  readonly mipLevelCount: number;
  readonly colorSpace: 'linear';
  /** Release all four maps and detach from the baker. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}
/** Device-bound PBR baker. Recreate after device replacement. */
export interface PBRTextureBaker {
  /** Bake all four maps and their mip chains on the GPU, with no CPU pixel loop/readback. */
  bake(options?: PBRTextureOptions): Promise<PBRTextureSet>;
  /** Release retained outputs and cancel outstanding waits. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}
const patterns: PBRTexturePattern[] = [
  'noise',
  'bricks',
  'tiles',
  'wood',
  'rust',
  'marble',
  'cloud',
  'grass',
  'fire',
  'starfield',
  'road',
];
const failed = (message: string) => fault('failed', message, 'procedural');
const palettes: Partial<
  Record<PBRTexturePattern, readonly [readonly [number, number, number], readonly [number, number, number]]>
> = {
  marble: [
    [0.9, 0.9, 0.85],
    [0.08, 0.1, 0.12],
  ],
  cloud: [
    [1, 1, 1],
    [0.08, 0.2, 0.5],
  ],
  grass: [
    [0.2, 0.5, 0.05],
    [0.02, 0.08, 0.01],
  ],
  fire: [
    [1, 0.8, 0.1],
    [0.15, 0.005, 0],
  ],
  starfield: [
    [1, 1, 1],
    [0.001, 0.002, 0.01],
  ],
  road: [
    [0.9, 0.85, 0.5],
    [0.04, 0.04, 0.045],
  ],
};
function settings(o: PBRTextureOptions, maximum: number) {
  if (!o || typeof o !== 'object' || Array.isArray(o))
    throw failed('PBR settings must be an object; pass bounded options');
  const pattern = o.pattern ?? 'bricks',
    kind = patterns.indexOf(pattern),
    color = o.color ?? palettes[pattern]?.[0],
    secondary = o.secondary ?? palettes[pattern]?.[1];
  const base = textureSettings(
    { ...o, color, secondary, pattern: kind < 5 ? (pattern as TextureBakeOptions['pattern']) : 'noise' },
    maximum,
  );
  const normalStrength = o.normalStrength ?? 1,
    heightScale = o.heightScale ?? 0.05,
    roughness = o.roughness ?? 0.7,
    roughnessVariation = o.roughnessVariation ?? 0.3,
    time = o.time ?? 0,
    mipmaps = o.mipmaps ?? true;
  if (
    kind < 0 ||
    !Number.isFinite(normalStrength) ||
    normalStrength < 0 ||
    normalStrength > 8 ||
    ![heightScale, roughness, roughnessVariation].every((x) => Number.isFinite(x) && x >= 0 && x <= 1) ||
    !Number.isFinite(time) ||
    time < 0 ||
    time > 1e6 ||
    typeof mipmaps !== 'boolean'
  )
    throw failed('Invalid PBR settings; use bounded strength, height, roughness, time and a boolean mipmaps');
  return { ...base, kind, normalStrength, heightScale, roughness, roughnessVariation, time, mipmaps };
}
async function waiting<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // Observe rejected driver work even when cancellation wins.
  const observed = promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  signal.throwIfAborted();
  let listener: () => void;
  const cancel = new Promise<never>((_, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener('abort', listener, { once: true });
  });
  try {
    const result = await Promise.race([observed, cancel]);
    signal.throwIfAborted();
    if ('error' in result) throw result.error;
    return result.value;
  } finally {
    signal.removeEventListener('abort', listener!);
  }
}
class Baker implements PBRTextureBaker {
  private outputs = new Set<PBRTextureSet>();
  private disposed = false;
  constructor(
    private device: GPUDevice,
    private base: GPUComputePipeline,
    private mip: GPUComputePipeline,
    private lifecycle: AbortController,
  ) {}
  async bake(options: PBRTextureOptions = {}): Promise<PBRTextureSet> {
    if (this.disposed) throw fault('disposed', 'PBR baker is disposed; create a new baker', 'procedural');
    this.lifecycle.signal.throwIfAborted();
    const o = settings(options, this.device.limits.maxTextureDimension2D),
      signal = options.signal ? AbortSignal.any([this.lifecycle.signal, options.signal]) : this.lifecycle.signal;
    signal.throwIfAborted();
    const count = o.mipmaps ? Math.floor(Math.log2(Math.max(o.width, o.height))) + 1 : 1,
      maps: GPUTexture[] = [],
      buffers: GPUBuffer[] = [];
    let complete = false;
    try {
      for (const label of ['albedo', 'normal', 'roughness', 'height'])
        maps.push(
          this.device.createTexture({
            label: 'procedural PBR ' + label,
            size: [o.width, o.height],
            mipLevelCount: count,
            format: 'rgba8unorm',
            usage: 4 | 8 | 1,
          }),
        );
      const uniform = this.device.createBuffer({ size: 96, usage: 64 | 8 });
      buffers.push(uniform);
      const bytes = new ArrayBuffer(96),
        ints = new Uint32Array(bytes),
        floats = new Float32Array(bytes);
      ints.set([o.width, o.height, o.kind, o.seed]);
      floats.set([...o.repeat, o.detail, o.grout], 4);
      floats.set([...o.color, 1, ...o.secondary, 1], 8);
      floats.set([...o.offset.map((x) => ((x % 1) + 1) % 1), o.stagger, o.time], 16);
      floats.set([o.normalStrength, o.heightScale, o.roughness, o.roughnessVariation], 20);
      this.device.queue.writeBuffer(uniform, 0, bytes);
      const encoder = this.device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(this.base);
      pass.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: this.base.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniform } },
            ...maps.map((t, i) => ({ binding: i + 1, resource: t.createView({ baseMipLevel: 0, mipLevelCount: 1 }) })),
          ],
        }),
      );
      pass.dispatchWorkgroups(Math.ceil(o.width / 8), Math.ceil(o.height / 8));
      pass.end();
      let width = o.width,
        height = o.height;
      for (let level = 1; level < count; level++) {
        const nextW = Math.max(1, width >> 1),
          nextH = Math.max(1, height >> 1);
        for (let map = 0; map < 4; map++) {
          const uniform = this.device.createBuffer({ size: 32, usage: 64 | 8 });
          buffers.push(uniform);
          this.device.queue.writeBuffer(
            uniform,
            0,
            new Uint32Array([nextW, nextH, width, height, map === 1 ? 1 : 0, 0, 0, 0]),
          );
          const pass = encoder.beginComputePass();
          pass.setPipeline(this.mip);
          pass.setBindGroup(
            0,
            this.device.createBindGroup({
              layout: this.mip.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: { buffer: uniform } },
                { binding: 1, resource: maps[map].createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
                { binding: 2, resource: maps[map].createView({ baseMipLevel: level, mipLevelCount: 1 }) },
              ],
            }),
          );
          pass.dispatchWorkgroups(Math.ceil(nextW / 8), Math.ceil(nextH / 8));
          pass.end();
        }
        width = nextW;
        height = nextH;
      }
      this.device.queue.submit([encoder.finish()]);
      await waiting(this.device.queue.onSubmittedWorkDone(), signal);
      const outputs = this.outputs;
      let disposed = false;
      const output: PBRTextureSet = {
        albedo: maps[0],
        normal: maps[1],
        roughness: maps[2],
        height: maps[3],
        width: o.width,
        heightPixels: o.height,
        mipLevelCount: count,
        colorSpace: 'linear',
        dispose() {
          if (disposed) return;
          disposed = true;
          for (const map of maps) map.destroy();
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
      signal.throwIfAborted();
      if (error instanceof Error && error.name === 'MargoError') throw error;
      throw Object.assign(failed('PBR bake failed; check the device error scope and recreate after loss'), {
        cause: error,
      });
    } finally {
      for (const buffer of buffers) buffer.destroy();
      if (!complete) for (const map of maps) map.destroy();
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycle.abort(fault('disposed', 'PBR baker was disposed; create a new baker', 'procedural'));
    for (const output of this.outputs) output.dispose();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
/** Compile GPU PBR baking on native WebGPU or a full WebGL2 compatibility device. Preview-only engines must install the full layer first. */
export async function createPBRTextureBaker(
  source: GPUDevice | Pick<EngineKernel, 'gpu'>,
  options: { signal?: AbortSignal } = {},
): Promise<PBRTextureBaker> {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw failed('PBR factory options must be an object; pass signal or an empty object');
  options.signal?.throwIfAborted();
  const device = source && typeof source === 'object' && 'gpu' in source ? source.gpu : (source as GPUDevice);
  if (!device || typeof device.createComputePipelineAsync !== 'function')
    throw fault(
      'unsupported',
      'PBR baking needs a GPU device; install the full WebGL2 compatibility layer or use WebGPU',
      'procedural',
    );
  const lifecycle = new AbortController(),
    ref = new WeakRef(lifecycle);
  void device.lost.then(() =>
    ref.deref()?.abort(failed('PBR device was lost; recreate the baker on the replacement device')),
  );
  const signal = options.signal ? AbortSignal.any([lifecycle.signal, options.signal]) : lifecycle.signal;
  try {
    const pipelines: GPUComputePipeline[] = [];
    for (const code of [pbrShader, pbrMipShader]) {
      const module = device.createShaderModule({ code, label: 'procedural/textures-pbr' }),
        info = await waiting(module.getCompilationInfo(), signal),
        error = info.messages.find((m) => m.type === 'error');
      if (error)
        throw failed(`PBR shader line ${error.lineNum}: ${error.message}; check the shader and device support`);
      pipelines.push(
        await waiting(
          device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } }),
          signal,
        ),
      );
    }
    return new Baker(device, pipelines[0], pipelines[1], lifecycle);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.name === 'MargoError') throw error;
    throw Object.assign(failed('PBR pipelines failed to compile; check device support'), { cause: error });
  }
}
