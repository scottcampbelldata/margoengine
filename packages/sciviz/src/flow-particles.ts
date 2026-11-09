import { hexColor, SRGBToLinear } from '@margoengine/math/color';
import { fault, rangeError } from '../../shared/errors.js';
import type { Figure } from './figure.js';
import { toScene, type Bounds } from './layer.js';
import type { FlowGrid } from './flow.js';
import { flowSeeds, validateFlowGrid, type FlowSeeding } from './flow-seeds.js';
import { flowCompute, flowDraw } from './flow-shaders.js';
import { requireGPU, type Drawable, type GpuContext, type SciRenderer } from './render.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number; COPY_SRC: number; MAP_READ: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number; COMPUTE: number };
declare const GPUMapMode: { READ: number };

/** Controls for GPU-resident moving-flow particles. All distances/times use the field's units. */
export interface FlowParticlesOptions {
  /** Particle count, 1..1000000. Default 1024. */
  readonly count?: number;
  /** Seed placement. Default uniform; fixed seeds are reused on respawn. */
  readonly seeding?: FlowSeeding;
  /** Initial time. Default first frame time. */
  readonly from?: number;
  /** History samples per particle, 2..256. Default 32. */
  readonly trails?: number;
  /** Positive particle lifetime, tested at each accepted step endpoint. Default 10 time units. */
  readonly lifetime?: number;
  /** Re-release dead particles at their seeds at the next step endpoint. Default true. */
  readonly respawn?: boolean;
  /** Trail width in device pixels, >0 and <=64. Default 2. */
  readonly width?: number;
  /** Linear opacity, 0..1. Default 0.8. Older trail samples fade quadratically. */
  readonly opacity?: number;
  /** sRGB hexadecimal colour. Default '#7ddcff'. */
  readonly color?: string;
  /** Maximum total substeps retained for deterministic device replay, 1..1000000. Default 10000. */
  readonly maxSteps?: number;
  /** Cancels validation/copying with its exact reason. No retained listener after creation. */
  readonly signal?: AbortSignal;
}

/** Advance through physical time. A cancelled call retains only already submitted substeps. */
export interface FlowAdvanceOptions {
  /** Positive maximum RK4 time step. Steps shorten at frame boundaries and `to`. */
  readonly step: number;
  readonly signal?: AbortSignal;
}

const yieldTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
// Headroom for interpolation sums and all four RK stages, including out-of-domain candidates.
const ARITHMETIC_LIMIT = 3.4028234663852886e38 / 16;
function fail(message: string): never { throw rangeError(message, 'sciviz'); }

/**
 * GPU RK4 particles and fading trails in a 3D figure (a planar grid is also supported).
 * Positions/history remain on the GPU during advance and draw. Device replacement replays accepted steps;
 * no readback is needed for recovery. Native WebGL2 awaits batch 181; WebGPU and webgl2-compat are supported.
 * Create with `flowParticles`, then `advance` explicitly; rendering never advances time.
 */
export class FlowParticles implements Drawable {
  visible = true;
  readonly transparent = true;
  readonly count: number;
  readonly trails: number;
  readonly #bounds: Bounds;
  readonly #renderer: SciRenderer;
  readonly #times: number[];
  #seeds: Float32Array;
  #velocities: Float32Array;
  readonly #values = new Float32Array(48);
  readonly #ints = new Uint32Array(this.#values.buffer);
  readonly #history: [number, number][] = [];
  readonly #maxSteps: number;
  readonly #from: number;
  readonly #maximumVelocity: number;
  #time: number;
  #head = 0;
  #device!: GPUDevice;
  #buffers: GPUBuffer[] = [];
  #computeLayout!: GPUBindGroupLayout;
  #drawLayout!: GPUBindGroupLayout;
  #computeGroup!: GPUBindGroup;
  #drawGroup!: GPUBindGroup;
  #initialize!: GPUComputePipeline;
  #advect!: GPUComputePipeline;
  #operation: symbol | undefined;
  #disposed = false;

  private constructor(figure: Figure, grid: FlowGrid, seeds: Float32Array, velocities: Float32Array, maximumVelocity: number, options: FlowParticlesOptions) {
    this.#renderer = figure.renderer;
    this.#times = grid.frames.map((frame) => frame.time);
    this.#bounds = [...grid.bounds];
    this.#seeds = seeds;
    this.#velocities = velocities;
    this.#maximumVelocity = maximumVelocity;
    this.count = seeds.length / 4;
    this.trails = options.trails ?? 32;
    this.#maxSteps = options.maxSteps ?? 10000;
    this.#from = this.#time = options.from ?? grid.frames[0].time;
    this.#values.set([grid.bounds[0], grid.bounds[2], grid.bounds[4], 0], 16);
    this.#values.set([grid.bounds[1], grid.bounds[3], grid.bounds[5], 0], 20);
    this.#ints.set([...grid.dims, grid.dims[0] * grid.dims[1] * grid.dims[2]], 24);
    this.#ints.set([this.count, this.trails, 0, 0, 0, options.respawn === false ? 0 : 1, 0, 0], 28);
    this.#values.set([options.lifetime ?? 10, options.width ?? 2, options.opacity ?? 0.8, 0], 40);
    const colour = hexColor(options.color ?? '#7ddcff');
    if (!colour) fail('Flow color needs a hexadecimal sRGB colour');
    this.#values.set([SRGBToLinear(colour[0]), SRGBToLinear(colour[1]), SRGBToLinear(colour[2]), 1], 44);
    this.#values[42] *= colour[3];
  }

  /** @internal Validates and copies the field in bounded tasks before publishing a layer. */
  static async create(figure: Figure, grid: FlowGrid, options: FlowParticlesOptions = {}): Promise<FlowParticles> {
    const signal = options.signal;
    signal?.throwIfAborted();
    requireGPU(figure.renderer);
    const size = validateFlowGrid(grid), count = options.count ?? 1024, trails = options.trails ?? 32;
    const from = options.from ?? grid.frames[0].time, maxSteps = options.maxSteps ?? 10000;
    const positive = (x: number) => Number.isFinite(x) && x > 0 && Number.isFinite(Math.fround(x)) && Math.fround(x) > 0;
    if (!Number.isInteger(trails) || trails < 2 || trails > 256 || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 1_000_000)
      fail('Flow trails need 2..256 samples and maxSteps needs 1..1000000');
    if (!Number.isInteger(count) || count < 1 || count > 1_000_000 || !positive(options.lifetime ?? 10) ||
        !positive(options.width ?? 2) || (options.width ?? 2) > 64 ||
        !Number.isFinite(options.opacity ?? 0.8) || (options.opacity ?? 0.8) < 0 || (options.opacity ?? 0.8) > 1)
      fail('Flow count, lifetime, width and opacity must lie in their documented ranges');
    if (options.respawn !== undefined && typeof options.respawn !== 'boolean')
      fail('Flow respawn must be a boolean');
    if (!Number.isFinite(from) || (grid.frames.length > 1 && (from < grid.frames[0].time || from > grid.frames.at(-1)!.time)))
      fail('Flow initial time must lie in the frame range');
    const widths = [0, 1, 2].map((c) => grid.bounds[2 * c + 1] - grid.bounds[2 * c]);
    if (grid.bounds.some((x) => !Number.isFinite(Math.fround(x))) || widths.some((x) => x !== 0 && !positive(x)) ||
        widths.some((x, c) => x > 0 && Math.fround(grid.bounds[2 * c]) === Math.fround(grid.bounds[2 * c + 1])))
      fail('GPU flow bounds and sampled widths must be representable in float32; use local coordinates');
    const bytes = [192, size * grid.frames.length * 16, count * 16, count * 32, count * trails * 16];
    const device = figure.renderer.device!;
    if (bytes.reduce((a, b) => a + b, 0) > 128 * 1024 * 1024 || bytes.some((n) => !Number.isSafeInteger(n) || n > device.limits.maxBufferSize) ||
        bytes.slice(1).some((n) => n > device.limits.maxStorageBufferBindingSize))
      fail('GPU flow buffers exceed the device limit or 128 MiB; reduce grid, frames, count or trails');
    const positions = flowSeeds(grid, count, options.seeding);
    const seeds = new Float32Array(count * 4), velocities = new Float32Array(size * grid.frames.length * 4);
    for (let i = 0; i < count; i++)
      for (let c = 0; c < 3; c++) seeds[i * 4 + c] = widths[c] ? (positions[i * 3 + c] - grid.bounds[2 * c]) / widths[c] : 0;
    let maximumVelocity = 0;
    for (let f = 0; f < grid.frames.length; f++) {
      const components = [grid.frames[f].u, grid.frames[f].v, grid.frames[f].w];
      for (let start = 0; start < size; start += 16384) {
        signal?.throwIfAborted();
        for (let i = start; i < Math.min(size, start + 16384); i++) {
          const at = (f * size + i) * 4;
          let valid = 1;
          for (let c = 0; c < 3; c++) {
            const v = components[c]?.[i] ?? 0;
            if (!Number.isFinite(v)) {
              if (!Number.isNaN(v)) fail('Flow velocities must be finite or NaN; remove infinite samples');
              valid = 0;
            }
            velocities[at + c] = Number.isNaN(v) ? 0 : v / (widths[c] || 1);
            maximumVelocity = Math.max(maximumVelocity, Math.abs(velocities[at + c]));
            if (maximumVelocity > ARITHMETIC_LIMIT) fail('GPU flow velocity exceeds float32 arithmetic headroom; rescale distance/time units');
          }
          velocities[at + 3] = valid;
        }
        await yieldTask();
      }
    }
    signal?.throwIfAborted();
    if (device !== figure.renderer.device) throw fault('state', 'Flow device changed during creation; create on the restored figure', 'sciviz');
    // Retain only frame times and copied immutable buffers, never the caller's mutable arrays.
    const layer = new FlowParticles(figure, grid, seeds, velocities, maximumVelocity, options);
    try {
      layer.#build();
      figure.addLayer(layer);
      figure.renderer.add(layer);
      return layer;
    } catch (error) {
      layer.dispose();
      throw error;
    }
  }

  /** Independent data bounds for the figure's axes. */
  get bounds(): Bounds { return [...this.#bounds]; }
  /** Time of the last submitted substep, or initial time before the first step. */
  get time(): number { return this.#time; }
  /** Accepted substeps, also the deterministic recovery work count. */
  get steps(): number { return this.#history.length; }
  /** @internal */
  setModel(model: Float32Array): void { this.#values.set(model, 0); }
  /** @internal */
  center(): readonly [number, number, number] {
    const b = this.#bounds;
    return toScene(this.#values, (b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2);
  }

  #check(): void {
    if (this.#disposed) throw fault('disposed', 'Create a new flow layer after disposal', 'sciviz');
    if (this.#device !== this.#renderer.device) throw fault('state', 'Await figure.ready() after device replacement', 'sciviz');
  }

  #interval(from: number, to: number): void {
    const frames = this.#times;
    let a = 0;
    while (a + 1 < frames.length - 1 && frames[a + 1] <= from) a++;
    const b = Math.min(a + 1, frames.length - 1), span = frames[b] - frames[a];
    this.#ints[31] = a;
    this.#ints[32] = b;
    this.#values.set([span ? (from - frames[a]) / span : 0, span ? (to - frames[a]) / span : 0, to - from, 0], 36);
  }

  #dispatch(pipeline: GPUComputePipeline): void {
    this.#device.queue.writeBuffer(this.#buffers[0], 0, this.#values);
    const encoder = this.#device.createCommandEncoder({ label: 'sciviz flow step' });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.#computeGroup);
    pass.dispatchWorkgroups(Math.ceil(this.count / 64));
    pass.end();
    this.#device.queue.submit([encoder.finish()]);
  }

  #step(to: number): void {
    this.#interval(this.#time, to);
    this.#head = (this.#head + 1) % this.trails;
    this.#ints[30] = this.#head;
    this.#dispatch(this.#advect);
    this.#time = to;
  }

  #build(): void {
    const device = this.#device = this.#renderer.device!;
    const sizes = [192, this.#velocities.byteLength, this.#seeds.byteLength, this.count * 32, this.count * this.trails * 16];
    for (let i = 0; i < sizes.length; i++) this.#buffers.push(device.createBuffer({
      size: sizes[i], usage: GPUBufferUsage.COPY_DST | (i ? GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC : GPUBufferUsage.UNIFORM),
    }));
    device.queue.writeBuffer(this.#buffers[1], 0, this.#velocities);
    device.queue.writeBuffer(this.#buffers[2], 0, this.#seeds);
    this.#computeLayout = device.createBindGroupLayout({ entries: sizes.map((_, i) => ({
      binding: i, visibility: GPUShaderStage.COMPUTE,
      buffer: { type: i === 0 ? 'uniform' : i < 3 ? 'read-only-storage' : 'storage' },
    })) });
    this.#computeGroup = device.createBindGroup({ layout: this.#computeLayout, entries: this.#buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const module = device.createShaderModule({ code: flowCompute, label: 'sciviz flow RK4' });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.#computeLayout] });
    this.#initialize = device.createComputePipeline({ layout, compute: { module, entryPoint: 'initialize' } });
    this.#advect = device.createComputePipeline({ layout, compute: { module, entryPoint: 'advect' } });
    this.#drawLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ] });
    this.#drawGroup = device.createBindGroup({ layout: this.#drawLayout, entries: [
      { binding: 0, resource: { buffer: this.#buffers[0] } },
      { binding: 1, resource: { buffer: this.#buffers[4] } },
    ] });
    this.#head = this.#ints[30] = 0;
    this.#time = this.#from;
    this.#interval(this.#from, this.#from);
    this.#dispatch(this.#initialize);
  }

  /**
   * Submits forward physical-time RK4 steps without reading positions back. Advances are exclusive;
   * simultaneous calls reject. Total accepted substeps may not exceed maxSteps. Input is copied at creation.
   * Yields between substeps for cancellation. Already submitted work remains when cancelled.
   */
  async advance(to: number, options: FlowAdvanceOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    this.#check();
    if (this.#operation) throw fault('state', 'Await the current flow operation before advancing', 'sciviz');
    const step = options?.step, frames = this.#times;
    if (!Number.isFinite(to) || to < this.#time || !Number.isFinite(to - this.#time) || !Number.isFinite(step) || step <= 0 ||
        (frames.length > 1 && to > frames.at(-1)!)) fail('Flow advance needs a covered forward time and positive finite step');
    const token = this.#operation = Symbol();
    try {
      while (this.#time < to) {
        options.signal?.throwIfAborted();
        this.#check();
        if (this.#operation !== token) throw fault('state', 'Flow operation lost ownership after device replacement', 'sciviz');
        if (this.steps >= this.#maxSteps) fail('Flow maxSteps recovery budget exhausted; create a new layer');
        let end = Math.min(to, this.#time + step);
        if (frames.length > 1) for (const time of frames) if (time > this.#time) { end = Math.min(end, time); break; }
        if (!(end > this.#time) || !Number.isFinite(Math.fround(end - this.#time)) || Math.fround(end - this.#time) <= 0)
          fail('Flow step cannot advance this time value in float32; use relative times or rescale units');
        if (Math.fround(end - this.#time) * this.#maximumVelocity > ARITHMETIC_LIMIT)
          fail('GPU flow step/velocity product exceeds float32 arithmetic headroom; reduce step or rescale units');
        const from = this.#time;
        this.#step(end);
        this.#history.push([from, end]);
        await yieldTask();
      }
      options.signal?.throwIfAborted();
      this.#check();
      if (this.#operation !== token) throw fault('state', 'Flow operation lost ownership after device replacement', 'sciviz');
    } finally { if (this.#operation === token) this.#operation = undefined; }
  }

  /**
   * Explicit inspection only: packed data-space xyz and particle age. Dead particles have age -1.
   * Default readback timeout 30000 ms. Cancels with the exact reason and frees the staging buffer.
   */
  async readPositions(options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}): Promise<Float32Array> {
    options.signal?.throwIfAborted();
    this.#check();
    const timeout = options.timeoutMs ?? 30000;
    if (!(timeout > 0) || !Number.isFinite(timeout) || timeout > 2147483647) fail('Flow readback timeoutMs must be positive and at most 2147483647');
    const buffer = this.#device.createBuffer({ size: this.count * 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const encoder = this.#device.createCommandEncoder();
      encoder.copyBufferToBuffer(this.#buffers[3], 0, buffer, 0, this.count * 32);
      this.#device.queue.submit([encoder.finish()]);
      await Promise.race([
        buffer.mapAsync(GPUMapMode.READ),
        new Promise<never>((_, reject) => {
          abort = () => reject(options.signal!.reason);
          options.signal?.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => reject(fault('timeout', 'Flow readback timed out; check GPU/device state', 'sciviz')), timeout);
        }),
      ]);
      options.signal?.throwIfAborted();
      this.#check();
      const raw = new Float32Array(buffer.getMappedRange()), ints = new Uint32Array(raw.buffer), result = new Float32Array(this.count * 4);
      for (let i = 0; i < this.count; i++) {
        for (let c = 0; c < 3; c++) result[4 * i + c] = this.#bounds[2 * c] + raw[8 * i + c] * (this.#bounds[2 * c + 1] - this.#bounds[2 * c]);
        result[4 * i + 3] = ints[8 * i + 5] ? raw[8 * i + 3] : -1;
      }
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort) options.signal?.removeEventListener('abort', abort);
      buffer.destroy();
    }
  }

  /** @internal Replays the exact accepted partition after device replacement. */
  async restore(): Promise<void> {
    if (this.#disposed) return;
    const token = this.#operation = Symbol();
    for (const buffer of this.#buffers) buffer.destroy();
    this.#buffers = [];
    try {
      this.#build();
      for (const [, to] of this.#history) {
        if (this.#disposed || this.#operation !== token) return;
        this.#step(to);
        await yieldTask();
      }
    } finally { if (this.#operation === token) this.#operation = undefined; }
  }

  /** @internal */
  prepare(): void { this.#device.queue.writeBuffer(this.#buffers[0], 0, this.#values); }
  /** @internal */
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    const pipeline = renderer.pipeline('flow-particles', context, (target) => {
      const module = this.#device.createShaderModule({ code: flowDraw, label: 'sciviz flow trails' });
      return {
        layout: this.#device.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout!, this.#drawLayout] }),
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: target.format, blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        } }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: target.depth, depthWriteEnabled: false, depthCompare: 'greater-equal' },
        multisample: target.multisample,
      };
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, this.#drawGroup);
    pass.draw(6, this.count * this.trails);
  }

  /** Releases all GPU buffers, retained field and replay history; idempotent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#operation = undefined;
    this.#renderer.remove(this);
    for (const buffer of this.#buffers) buffer.destroy();
    this.#buffers = [];
    this.#history.length = 0;
    this.#seeds = new Float32Array();
    this.#velocities = new Float32Array();
  }
  [Symbol.dispose](): void { this.dispose(); }
}

/** Creates a GPU particle/trail layer, copying inputs before joining a 3D figure's bounds and disposal. */
export function flowParticles(figure: Figure, grid: FlowGrid, options: FlowParticlesOptions = {}): Promise<FlowParticles> {
  return FlowParticles.create(figure, grid, options);
}
