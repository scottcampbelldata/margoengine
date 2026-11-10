/// <reference lib="esnext.disposable" preserve="true" />
import { multiplyMatrices } from '@margoengine/math/mat4';
import { hexColor } from '@margoengine/math/color';
import { fault, rangeError } from '../../shared/errors.js';
import type { Figure, ScatterLayer } from './figure.js';
import type { Bounds } from './layer.js';
import type { ColumnarTable, CrossFilter, TableAggregate, TableAggregateOptions } from './table.js';
import type { Drawable, GpuContext, SciRenderer } from './render.js';
import { blurShader, countShader, densityDrawShader } from './density-shaders.js';

declare const GPUBufferUsage: {
  UNIFORM: number;
  COPY_DST: number;
  STORAGE: number;
  COPY_SRC: number;
  MAP_READ: number;
};
declare const GPUShaderStage: { COMPUTE: number; FRAGMENT: number };
declare const GPUMapMode: { READ: number };

/** Screen-space density styling. Counts never depend on these choices. */
export interface DensityStyle {
  /** 'count' (default) or a separable Gaussian over pixel counts. */ readonly mode?: 'count' | 'kernel';
  /** Gaussian standard deviation in drawing-buffer pixels, (0,32]. Default 4. */ readonly bandwidth?: number;
  /** Opacity of one count, [0,1]. Default 0.08. Coincident marks use 1-(1-opacity)^count. */ readonly opacity?: number;
  /** sRGB colour. Default '#56b4e9'. */ readonly color?: string;
}
/** Optional density layer; all finite, in-frustum points vote once, with no point budget. */
export interface DensityOptions extends DensityStyle {
  /** Figure dimensionality. Default '2d'; use '3d' for an orbiting scatter. */ readonly dimensions?: '2d' | '3d';
  /** Abandons construction before publication. */ readonly signal?: AbortSignal;
}
/** Bounded asynchronous readback of the last rendered integer histogram, top row first. */
export interface DensityReadOptions {
  readonly signal?: AbortSignal;
  /** Hard deadline in milliseconds. Default 30000. */ readonly timeout?: number;
}
interface Chunk {
  buffer: GPUBuffer;
  group: GPUBindGroup;
  points: number;
}
const LINKED_DRAW: unique symbol = Symbol.for('@margoengine/sciviz/linked-draw') as never;
type Source = ScatterLayer['cloud'] & { [LINKED_DRAW]?: { readonly visible: boolean } };

function style(input: DensityStyle): Required<DensityStyle> {
  const result = {
    mode: input.mode ?? 'count',
    bandwidth: input.bandwidth ?? 4,
    opacity: input.opacity ?? 0.08,
    color: input.color ?? '#56b4e9',
  };
  if (
    !['count', 'kernel'].includes(result.mode) ||
    !Number.isFinite(result.bandwidth) ||
    result.bandwidth <= 0 ||
    result.bandwidth > 32 ||
    !Number.isFinite(result.opacity) ||
    result.opacity < 0 ||
    result.opacity > 1 ||
    !hexColor(result.color)
  )
    throw rangeError(
      'Density needs count/kernel mode, bandwidth in (0,32], opacity in [0,1] and a hex colour',
      'sciviz',
    );
  return result;
}
function bounds(positions: Float32Array): Bounds {
  const result: Bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    if (!Number.isFinite(positions[i]) || !Number.isFinite(positions[i + 1]) || !Number.isFinite(positions[i + 2]))
      continue;
    for (let a = 0; a < 3; a++) {
      result[a * 2] = Math.min(result[a * 2], positions[i + a]);
      result[a * 2 + 1] = Math.max(result[a * 2 + 1], positions[i + a]);
    }
  }
  return Number.isFinite(result[0]) ? result : [0, 1, 0, 1, 0, 0];
}

/**
 * A pixel histogram with exact u32 counts, optional Gaussian smoothing, and opacity compositing.
 * Inputs upload once in device-limited chunks. Rebinning happens on camera/model/viewport changes.
 * Native WebGPU uses integer atomics; webgl2-compat chooses its supported compute tier.
 */
export class DensityLayer implements Drawable {
  readonly transparent = true;
  readonly dimensions: '2d' | '3d';
  visible = true;
  readonly #renderer: SciRenderer;
  readonly #source?: ScatterLayer;
  #originalVisible?: boolean;
  #boundCloud?: Source;
  readonly #positions: Float32Array;
  readonly #bounds: Bounds;
  #style: Required<DensityStyle>;
  #model = new Float32Array(16);
  #uniform = new Float32Array(32);
  #device?: GPUDevice;
  #params?: GPUBuffer;
  #counts?: GPUBuffer;
  #temp?: GPUBuffer;
  #smooth?: GPUBuffer;
  #dummy?: GPUBuffer;
  #chunks: Chunk[] = [];
  #countLayout?: GPUBindGroupLayout;
  #countPipeline?: GPUComputePipeline;
  #blurLayout?: GPUBindGroupLayout;
  #blurPipelines: GPUComputePipeline[] = [];
  #drawLayout?: GPUBindGroupLayout;
  #drawGroup?: GPUBindGroup;
  #blurGroups: GPUBindGroup[] = [];
  #width = 0;
  #height = 0;
  #dirty = true;
  #blurDirty = true;
  #disposed = false;
  #uploaded?: Float32Array;
  readonly #lifetime = new AbortController();

  /** Prefer densityScatter(), which also publishes the layer in the figure. */
  constructor(figure: Figure, input: Float32Array | ScatterLayer, options: DensityOptions = {}) {
    options.signal?.throwIfAborted();
    this.#style = style(options);
    this.dimensions = options.dimensions ?? '2d';
    if (this.dimensions !== '2d' && this.dimensions !== '3d')
      throw rangeError('Density dimensions must be 2d or 3d', 'sciviz');
    if (!(input instanceof Float32Array)) {
      if (!figure.layers.includes(input)) throw rangeError('The scatter must belong to this figure', 'sciviz');
      const cloud = input.cloud as Source;
      if (cloud[LINKED_DRAW])
        throw fault('state', 'Remove the existing scatter replacement before attaching density', 'sciviz');
      this.#source = input;
      this.#originalVisible = cloud.visible;
      this.visible = cloud.visible;
    }
    this.#positions = this.#source ? this.#source.cloud.positions : (input as Float32Array);
    if (this.#positions.length % 3 || this.#positions.length / 3 > 0xffffffff)
      throw rangeError('Density needs interleaved xyz with at most 4294967295 points', 'sciviz');
    this.#bounds = this.#source?.bounds ?? bounds(this.#positions);
    this.#renderer = figure.renderer;
    if (!this.#renderer.device) throw fault('unsupported', 'Density needs WebGPU or createFallbackFigure', 'sciviz');
    this.#build();
    if (this.#source) this.#bindSource();
  }
  /** Data bounds. A source scatter keeps its existing plot-coordinate transform. */
  get bounds(): Bounds {
    return this.#source?.bounds ?? this.#bounds;
  }
  /** Full source count, independent of the figure point budget. */
  get count(): number {
    return this.#input().length / 3;
  }
  /** Last raster dimensions in drawing-buffer pixels (zero before the first frame). */
  get rasterSize(): readonly [number, number] {
    return [this.#width, this.#height];
  }
  /** Borrowed input and GPU allocations for fig.stats/monitor. */
  get memoryResources(): import('./resources.js').LayerResources {
    return {
      cpu: [this.#input(), this.#uniform, this.#model],
      gpu: this.#disposed
        ? []
        : [
            ...this.#chunks.map((c) => c.buffer),
            ...[this.#params, this.#counts, this.#temp, this.#smooth, this.#dummy].filter((b): b is GPUBuffer => !!b),
          ],
    };
  }
  #bindSource(): void {
    const cloud = this.#source!.cloud as Source;
    if (cloud === this.#boundCloud) return;
    if (cloud[LINKED_DRAW])
      throw fault('state', 'Remove the existing scatter replacement before attaching density', 'sciviz');
    this.#unbindSource();
    this.#originalVisible ??= cloud.visible;
    this.#boundCloud = cloud;
    cloud[LINKED_DRAW] = this;
    cloud.visible = false;
  }
  #unbindSource(): void {
    const cloud = this.#boundCloud;
    if (cloud?.[LINKED_DRAW] === this) {
      delete cloud[LINKED_DRAW];
      cloud.visible = this.#originalVisible!;
    }
    this.#boundCloud = undefined;
  }
  #input(): Float32Array {
    if (this.#source && !this.#disposed) this.#bindSource();
    return this.#source?.cloud.positions ?? this.#positions;
  }
  #check(): void {
    if (this.#disposed) throw fault('disposed', 'Create a new density layer after disposal', 'sciviz');
  }
  /** Re-upload after an in-place position edit. Replacing a source cloud array is detected automatically. */
  invalidate(): void {
    this.#check();
    this.#uploaded = undefined;
    this.#dirty = true;
  }
  /** Changes presentation without re-uploading or dropping any points. */
  setStyle(options: DensityStyle): void {
    this.#check();
    this.#style = style({ ...this.#style, ...options });
    this.#blurDirty = true;
  }
  /** Exact data-space bins/statistics, including CrossFilter predicates; independent of visual KDE. */
  async aggregate(input: ColumnarTable | CrossFilter, options: TableAggregateOptions): Promise<TableAggregate> {
    this.#check();
    const { aggregateTable } = await import('@margoengine/sciviz/table');
    return aggregateTable(input, {
      ...options,
      signal: AbortSignal.any([this.#lifetime.signal, ...(options.signal ? [options.signal] : [])]),
    });
  }
  /** @internal Figure transform. */
  setModel(model: Float32Array): void {
    if (model.some((v, i) => v !== this.#model[i])) {
      this.#model.set(model);
      this.#dirty = true;
    }
  }
  /** @internal Density is composited as a screen overlay, after opaque layers. */
  center(): readonly [number, number, number] {
    return [0, 0, 0];
  }
  #release(): void {
    for (const c of this.#chunks) c.buffer.destroy();
    this.#chunks = [];
    for (const b of [this.#params, this.#counts, this.#temp, this.#smooth, this.#dummy]) b?.destroy();
    this.#params = this.#counts = this.#temp = this.#smooth = this.#dummy = undefined;
    this.#uploaded = undefined;
    this.#width = this.#height = 0;
    this.#dirty = true;
    this.#blurDirty = true;
  }
  #build(): void {
    const device = this.#renderer.device!;
    this.#device = device;
    this.#params = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#dummy = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE });
    const uniform = { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' as const } };
    this.#countLayout = device.createBindGroupLayout({
      entries: [
        uniform,
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    this.#countPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.#countLayout] }),
      compute: { module: device.createShaderModule({ code: countShader }), entryPoint: 'main' },
    });
    this.#blurLayout = device.createBindGroupLayout({
      entries: [
        uniform,
        ...[1, 2, 3].map((binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: binding === 3 ? ('storage' as const) : ('read-only-storage' as const) },
        })),
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.#blurLayout] }),
      module = device.createShaderModule({ code: blurShader });
    this.#blurPipelines = ['horizontal', 'vertical'].map((entryPoint) =>
      device.createComputePipeline({ layout, compute: { module, entryPoint } }),
    );
    this.#drawLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ...[1, 2].map((binding) => ({
          binding,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' as const },
        })),
      ],
    });
  }
  /** @internal Device restore rebuilds pipelines and lazily uploads the full source again. */
  restore(): void {
    if (this.#disposed) return;
    this.#release();
    this.#build();
  }
  #raster(width: number, height: number): void {
    const device = this.#device!,
      bytes = width * height * 4;
    if (
      bytes > device.limits.maxStorageBufferBindingSize ||
      bytes > device.limits.maxBufferSize ||
      width > 8192 ||
      height > 8192 ||
      width * height > 16777216
    )
      throw rangeError(
        'Density raster exceeds device storage limits, 8192 per axis or 16777216 pixels; reduce canvas resolution',
        'sciviz',
      );
    for (const b of [this.#counts, this.#temp, this.#smooth]) b?.destroy();
    this.#counts = device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.#temp = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE });
    this.#smooth = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE });
    const group = (layout: GPUBindGroupLayout, buffers: GPUBuffer[]) =>
      device.createBindGroup({
        layout,
        entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
    this.#drawGroup = group(this.#drawLayout!, [this.#params!, this.#counts, this.#smooth]);
    this.#blurGroups = [
      group(this.#blurLayout!, [this.#params!, this.#counts, this.#dummy!, this.#temp]),
      group(this.#blurLayout!, [this.#params!, this.#counts, this.#temp, this.#smooth]),
    ];
    this.#width = width;
    this.#height = height;
    this.#uploaded = undefined;
    this.#dirty = true;
  }
  #upload(): void {
    const device = this.#device!,
      input = this.#input();
    if (input === this.#uploaded) return;
    if (input.length % 3 || input.length / 3 > 0xffffffff)
      throw rangeError('Density needs complete xyz positions within u32 count range', 'sciviz');
    for (const c of this.#chunks) c.buffer.destroy();
    this.#chunks = [];
    const chunk = Math.min(
      1048576,
      Math.floor(device.limits.maxStorageBufferBindingSize / 12),
      Math.floor(device.limits.maxBufferSize / 12),
      device.limits.maxComputeWorkgroupsPerDimension * 64,
    );
    if (chunk < 1) throw fault('unsupported', 'Density needs storage for at least one xyz point', 'sciviz');
    for (let start = 0; start < input.length; start += chunk * 3) {
      const data = input.subarray(start, Math.min(input.length, start + chunk * 3)),
        buffer = device.createBuffer({
          size: data.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
      device.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>);
      const group = device.createBindGroup({
        layout: this.#countLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.#params! } },
          { binding: 1, resource: { buffer } },
          { binding: 2, resource: { buffer: this.#counts! } },
        ],
      });
      this.#chunks.push({ buffer, group, points: data.length / 3 });
    }
    this.#uploaded = input;
    this.#dirty = true;
  }
  /** @internal Rebin only on camera/model/input/viewport changes; counts are never f16 or blended floats. */
  prepare(context: GpuContext): void {
    this.#check();
    if (this.#device !== this.#renderer.device) this.restore();
    if (context.width !== this.#width || context.height !== this.#height) this.#raster(context.width, context.height);
    this.#upload();
    const next = new Float32Array(32);
    multiplyMatrices(context.camera.matrix, this.#model, next.subarray(0, 16));
    const viewport = context.view?.viewport ?? [0, 0, context.width, context.height],
      scissor = context.view?.scissor ?? viewport;
    next.set(viewport, 16);
    next.set(scissor, 20);
    for (let i = 0; i < 24; i++)
      if (next[i] !== this.#uniform[i]) {
        this.#dirty = true;
        break;
      }
    const { bandwidth, mode, opacity, color } = this.#style,
      rgb = hexColor(color)!;
    const linear = rgb.slice(0, 3).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const alpha = opacity * rgb[3];
    next.set([...linear, alpha === 1 ? -1 : -Math.log1p(-alpha)], 24);
    next.set([context.width, context.height, bandwidth, mode === 'kernel' ? 1 : 0], 28);
    this.#uniform.set(next);
    this.#device!.queue.writeBuffer(this.#params!, 0, next);
    if (this.#dirty) {
      context.encoder.clearBuffer(this.#counts!);
      const pass = context.encoder.beginComputePass();
      pass.setPipeline(this.#countPipeline!);
      for (const c of this.#chunks) {
        pass.setBindGroup(0, c.group);
        pass.dispatchWorkgroups(Math.ceil(c.points / 64));
      }
      pass.end();
      this.#blurDirty = true;
      this.#dirty = false;
    }
    if (mode === 'kernel' && this.#blurDirty) {
      const pass = context.encoder.beginComputePass();
      for (let i = 0; i < 2; i++) {
        pass.setPipeline(this.#blurPipelines[i]);
        pass.setBindGroup(0, this.#blurGroups[i]);
        pass.dispatchWorkgroups(Math.ceil(this.#width / 8), Math.ceil(this.#height / 8));
      }
      pass.end();
      this.#blurDirty = false;
    }
  }
  /** @internal Composite one screen-sized triangle. */
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    const pipeline = renderer.pipeline('density-overlay', context, ({ format, depth, multisample }) => ({
      layout: this.#device!.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout!, this.#drawLayout!] }),
      vertex: { module: this.#device!.createShaderModule({ code: densityDrawShader }), entryPoint: 'vertex' },
      fragment: {
        module: this.#device!.createShaderModule({ code: densityDrawShader }),
        entryPoint: 'fragment',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: depth, depthWriteEnabled: false, depthCompare: 'always' },
      multisample,
    }));
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, this.#drawGroup!);
    pass.draw(3);
  }
  /** Reads exact counts of the last render. Rendering and all transfers obey submission order. */
  async readCounts(options: DensityReadOptions = {}): Promise<Uint32Array> {
    this.#check();
    const timeout = options.timeout ?? 30000;
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw rangeError('Density read timeout must be finite and positive', 'sciviz');
    const signal = AbortSignal.any([
      this.#lifetime.signal,
      AbortSignal.timeout(Math.ceil(timeout)),
      ...(options.signal ? [options.signal] : []),
    ]);
    signal.throwIfAborted();
    if (!this.#counts) throw fault('state', 'Render the figure before reading density counts', 'sciviz');
    const device = this.#device!,
      read = device.createBuffer({
        size: this.#width * this.#height * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.#counts, 0, read, 0, read.size);
    device.queue.submit([encoder.finish()]);
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        read.mapAsync(GPUMapMode.READ),
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
      signal.throwIfAborted();
      return new Uint32Array(read.getMappedRange().slice(0));
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
      read.destroy();
    }
  }
  /** Frees resources, removes the drawable, and restores an attached scatter's original visibility. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifetime.abort(fault('disposed', 'Density layer was disposed', 'sciviz'));
    this.#renderer.remove(this);
    this.#release();
    const current = this.#source?.cloud as Source | undefined,
      bound = this.#boundCloud;
    this.#unbindSource();
    if (current && current !== bound && !current[LINKED_DRAW]) current.visible = this.#originalVisible!;
  }
  /** Same as dispose(), for using. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Adds all-point density directly, or replaces an existing scatter's budgeted drawing while retaining its picks. */
export function densityScatter(
  figure: Figure,
  input: Float32Array | ScatterLayer,
  options: DensityOptions = {},
): DensityLayer {
  const layer = new DensityLayer(figure, input, options);
  try {
    figure.addLayer(layer);
    figure.renderer.add(layer);
    return layer;
  } catch (error) {
    layer.dispose();
    throw error;
  }
}
