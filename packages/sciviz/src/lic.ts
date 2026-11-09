// GPU LIC on regular fields and affine planar slices. Research: docs/clean-room.md.
import { fault, rangeError } from '../../shared/errors.js';
import type { Figure } from './figure.js';
import type { VectorGrid } from './fields.js';
import { colormapTexture, rangeOption, resolveColormap, toScene, type Bounds, type ColormapSource } from './layer.js';
import { requireGPU, type Drawable, type GpuContext, type SciRenderer } from './render.js';
import { licCompute, licDraw } from './lic-shaders.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number; COPY_SRC: number; MAP_READ: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number; COMPUTE: number };
declare const GPUMapMode: { READ: number };

/** A planar slice: data position = origin + u * axisU + v * axisV, with u/v in [0, 1]. */
export interface LicSlice {
  readonly origin: readonly [number, number, number];
  /** Full first edge in data units. Need not be perpendicular to axisV. */
  readonly axisU: readonly [number, number, number];
  /** Full second edge in data units. Must be independent of axisU. */
  readonly axisV: readonly [number, number, number];
}

/** Dense line integral convolution, separate from the root entry and its field grid resolution. */
export interface LicOptions {
  /** Output/noise texels, each dimension 8..2048. Default [256, 256]. */
  readonly resolution?: readonly [number, number];
  /** Samples each way along a streamline, 1..128. Default 20. */
  readonly steps?: number;
  /** Midpoint integration step in image texels, 0.1..1. Default 0.5. */
  readonly step?: number;
  /** Unsigned 32-bit noise seed. Default 0. */
  readonly seed?: number;
  /** Slice through a 3D field. Default full x/y plane at the grid's lowest z. */
  readonly slice?: LicSlice;
  /** Colour values at field nodes (NaN masks the node). Default interpolated vector speed. */
  readonly scalar?: ArrayLike<number>;
  /** Scalar colour range; default finite node extent (speed if scalar absent). */
  readonly range?: readonly [number, number];
  /** Colour map. Default 'aurora'. */
  readonly colormap?: ColormapSource;
  /** Multiply LIC luminance by the scalar colour. Default true; false gives grayscale. */
  readonly coloured?: boolean;
  /** Contrast about 0.5, 0..10. Default 3. */
  readonly contrast?: number;
  /** Enable a Hann-windowed periodic motion filter. Default false. Animation shows direction, not physical time. */
  readonly animated?: boolean;
  /** Initial animation phase in radians. Default 0; rendering never advances phase. */
  readonly phase?: number;
  /** Linear opacity, 0..1. Default 1. */
  readonly opacity?: number;
  /** Cancels validation/copying with its exact reason. Default absent; not retained after creation. */
  readonly signal?: AbortSignal;
}

const fail = (message: string): never => { throw rangeError(message, 'sciviz'); };
const task = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
const phaseOf = (phase: number) => {
  if (!Number.isFinite(phase)) fail('LIC phase must be finite');
  return ((phase % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
};

/** GPU-resident LIC image on a physical plane. Create with `lic`; rendering reuses the image until phase changes. */
export class LicLayer implements Drawable {
  visible = true;
  readonly transparent: boolean;
  readonly #renderer: SciRenderer;
  readonly #bounds: Bounds;
  readonly #resolution: readonly [number, number];
  readonly #values: Float32Array;
  readonly #map: ReturnType<typeof resolveColormap>;
  #field: Float32Array;
  #device!: GPUDevice;
  #buffers: GPUBuffer[] = [];
  #texture: GPUTexture | undefined;
  #computeGroup!: GPUBindGroup;
  #drawGroup!: GPUBindGroup;
  #drawLayout!: GPUBindGroupLayout;
  #compute!: GPUComputePipeline;
  #dirty = true;
  #disposed = false;

  private constructor(figure: Figure, field: Float32Array, values: Float32Array, bounds: Bounds, options: LicOptions) {
    this.#renderer = figure.renderer;
    this.#field = field;
    this.#values = values;
    this.#bounds = bounds;
    this.#resolution = [...(options.resolution ?? [256, 256])];
    this.#map = resolveColormap(options.colormap);
    this.transparent = (options.opacity ?? 1) < 1;
  }

  /** @internal Validates and copies the field in bounded tasks, before allocating or publishing anything. */
  static async create(figure: Figure, grid: VectorGrid, options: LicOptions = {}): Promise<LicLayer> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const dims = grid?.dims, b = grid?.bounds;
    if (!dims || dims.length !== 3 || dims.some((n, i) => !Number.isSafeInteger(n) || n < (i < 2 ? 2 : 1)))
      fail('LIC dims need x/y >= 2 and z >= 1 integer samples');
    if (!b || b.length !== 6 || b.some((v) => !Number.isFinite(v))) fail('LIC bounds need six finite coordinates');
    const span = [0, 1, 2].map((c) => b[2 * c + 1] - b[2 * c]);
    if (span.some((s, c) => !Number.isFinite(s) || (dims[c] === 1 ? s !== 0 : s <= 0)))
      fail('LIC bounds must ascend on sampled axes and be equal on singleton z');
    const n = dims[0] * dims[1] * dims[2];
    const resolution = options.resolution ?? [256, 256], steps = options.steps ?? 20, step = options.step ?? 0.5;
    const seed = options.seed ?? 0, contrast = options.contrast ?? 3, opacity = options.opacity ?? 1;
    if (!Number.isSafeInteger(n) || n * 48 > 128 * 1024 * 1024) fail('LIC copied field must fit the 128 MiB working budget');
    if (resolution.length !== 2 || resolution.some((v) => !Number.isInteger(v) || v < 8 || v > 2048))
      fail('LIC resolution needs two integer dimensions in 8..2048');
    if (!Number.isInteger(steps) || steps < 1 || steps > 128 || !Number.isFinite(step) || step < 0.1 || step > 1 ||
        !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isFinite(contrast) || contrast < 0 || contrast > 10 ||
        !Number.isFinite(opacity) || opacity < 0 || opacity > 1)
      fail('LIC steps, step, seed, contrast and opacity must lie in their documented ranges');
    if ([options.animated, options.coloured].some((v) => v !== undefined && typeof v !== 'boolean'))
      fail('LIC animated and coloured options must be booleans');
    const phase = phaseOf(options.phase ?? 0);
    for (const a of [grid.u, grid.v, ...(grid.w === undefined ? [] : [grid.w]), ...(options.scalar === undefined ? [] : [options.scalar])])
      if (!a || a.length !== n) fail('LIC components and scalar need one number per field node');
    const slice = options.slice ?? { origin: [b[0], b[2], b[4]], axisU: [span[0], 0, 0], axisV: [0, span[1], 0] };
    const vectors = [slice.origin, slice.axisU, slice.axisV];
    if (vectors.some((v) => !v || v.length !== 3 || v.some((x) => !Number.isFinite(x) || Math.abs(x) > 1e15)))
      fail('LIC slice needs finite xyz origin and edges within +/-1e15; use local coordinates');
    const [origin, u, v] = vectors;
    const uu = dot(u, u), vv = dot(v, v), uv = dot(u, v), det = uu * vv - uv * uv;
    if (!(det > uu * vv * 1e-8)) fail('LIC slice edges must be independent, with sin(angle)^2 > 1e-8');
    const dualU = u.map((x, c) => (vv * x - uv * v[c]) / det);
    const dualV = v.map((x, c) => (uu * x - uv * u[c]) / det);
    // A common scale cancels on direction normalization and prevents overflow/underflow in the shader.
    const dualScale = Math.max(...dualU.map(Math.abs), ...dualV.map(Math.abs));
    const values = new Float32Array(64), ints = new Uint32Array(values.buffer);
    values.set(origin, 16); values.set(u, 20); values.set(v, 24);
    for (let c = 0; c < 3; c++) {
      values[28 + c] = span[c] ? (origin[c] - b[c * 2]) / span[c] : 0;
      values[32 + c] = span[c] ? u[c] / span[c] : 0;
      values[36 + c] = span[c] ? v[c] / span[c] : 0;
      if (!span[c] && (origin[c] !== b[2 * c] || u[c] !== 0 || v[c] !== 0))
        fail('LIC slice must lie in the singleton z plane');
      values[40 + c] = dualU[c] / dualScale;
      values[44 + c] = dualV[c] / dualScale;
    }
    if (values.some((x) => !Number.isFinite(x) || Math.abs(x) > 1e15)) fail('LIC slice mapping exceeds float32 arithmetic headroom; use local coordinates');
    const corners = [origin, origin.map((x, c) => x + u[c]), origin.map((x, c) => x + v[c]), origin.map((x, c) => x + u[c] + v[c])];
    const bounds = [0, 1, 2].flatMap((c) => [Math.min(...corners.map((p) => p[c])), Math.max(...corners.map((p) => p[c]))]) as Bounds;
    let scale = 0, lo = Infinity, hi = -Infinity;
    const source = new Float64Array(n * 4);
    for (let start = 0; start < n; start += 16384) {
      signal?.throwIfAborted();
      for (let i = start; i < Math.min(n, start + 16384); i++) {
        const a = [grid.u[i], grid.v[i], grid.w === undefined ? 0 : grid.w[i]];
        const scalar = options.scalar === undefined ? Math.hypot(...a) : options.scalar[i];
        if ([...a, scalar].some((x) => !Number.isFinite(x) && !Number.isNaN(x))) fail('LIC samples must be finite or NaN');
        if (a.some(Number.isNaN) || Number.isNaN(scalar)) { source[4 * i + 3] = NaN; continue; }
        if (a.some((x) => Math.abs(x) > 1e30) || Math.abs(scalar) > 1e30) fail('LIC samples exceed +/-1e30; rescale field units');
        source.set(a, 4 * i); source[4 * i + 3] = scalar;
        scale = Math.max(scale, ...a.map(Math.abs)); lo = Math.min(lo, scalar); hi = Math.max(hi, scalar);
      }
      await task();
    }
    const range = rangeOption(options.range, 'LIC range') ?? (lo <= hi ? [lo, hi > lo ? hi : lo + Math.max(1, Math.abs(lo) * 1e-6)] : [0, 1]);
    const width = range[1] - range[0];
    if (!(width > 0) || !Number.isFinite(width) || Math.abs(range[0] / width) > 1e15 || scale / width > 1e15)
      fail('LIC colour range needs representable float32 ratios; rescale scalar units');
    const field = new Float32Array(n * 4);
    for (let start = 0; start < n; start += 16384) {
      signal?.throwIfAborted();
      for (let i = start; i < Math.min(n, start + 16384); i++) {
        const relative = Math.max(Math.abs(source[4 * i]), Math.abs(source[4 * i + 1]), Math.abs(source[4 * i + 2])) / (scale || 1);
        if (relative > 0 && relative < 8 * 2 ** -126)
          fail('LIC nonzero field nodes must retain eight float32 normal units after common scaling; split fields with excessive dynamic range');
        for (let c = 0; c < 3; c++) field[4 * i + c] = source[4 * i + c] / (scale || 1);
        field[4 * i + 3] = (source[4 * i + 3] - range[0]) / width;
        if (!Number.isFinite(field[4 * i + 3]) && !Number.isNaN(field[4 * i + 3])) fail('LIC scalar range overflows float32; rescale scalar units');
      }
      await task();
    }
    ints.set([...dims, options.scalar ? 1 : 0], 48);
    ints.set([...resolution, steps, seed], 52);
    values.set([step, contrast, phase, options.animated ? 1 : 0], 56);
    values.set([scale / width, -range[0] / width, opacity, options.coloured === false ? 0 : 1], 60);
    signal?.throwIfAborted();
    requireGPU(figure.renderer);
    const device = figure.renderer.device!;
    for (const bytes of [field.byteLength, resolution[0] * resolution[1] * 16])
      if (bytes > device.limits.maxStorageBufferBindingSize || bytes > device.limits.maxBufferSize)
        fail('LIC image or field exceeds device buffer limits; reduce grid or resolution');
    const layer = new LicLayer(figure, field, values, bounds, options);
    try { layer.#build(); figure.addLayer(layer); figure.renderer.add(layer); return layer; }
    catch (error) { layer.dispose(); throw error; }
  }

  /** Independent image dimensions; x fastest, row zero at slice v = 0. */
  get resolution(): readonly [number, number] { return [...this.#resolution]; }
  /** The physical slice's bounds, including portions outside the field (which are transparent). */
  get bounds(): Bounds { return [...this.#bounds]; }
  /** Current phase modulo 2*pi in radians. */
  get phase(): number { return this.#values[58]; }
  /** Sets animation phase explicitly; no clock or callback is retained. Also safe while awaiting restoration. */
  setPhase(phase: number): void { this.#check(); this.#values[58] = phaseOf(phase); this.#dirty = true; }
  /** @internal */
  setModel(model: Float32Array): void { this.#values.set(model); }
  /** @internal */
  center(): readonly [number, number, number] {
    const b = this.#bounds;
    return toScene(this.#values, (b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2);
  }
  #check(): void { if (this.#disposed) throw fault('disposed', 'Create a new LIC layer after disposal', 'sciviz'); }
  #build(): void {
    const device = this.#device = this.#renderer.device!;
    const sizes = [256, this.#field.byteLength, this.#resolution[0] * this.#resolution[1] * 16];
    for (let i = 0; i < sizes.length; i++) this.#buffers.push(device.createBuffer({ size: sizes[i],
      usage: GPUBufferUsage.COPY_DST | (i ? GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC : GPUBufferUsage.UNIFORM) }));
    device.queue.writeBuffer(this.#buffers[1], 0, this.#field);
    const layout = device.createBindGroupLayout({ entries: sizes.map((_, i) => ({ binding: i, visibility: GPUShaderStage.COMPUTE,
      buffer: { type: i === 0 ? 'uniform' : i === 1 ? 'read-only-storage' : 'storage' } })) });
    this.#computeGroup = device.createBindGroup({ layout, entries: this.#buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
    this.#compute = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: device.createShaderModule({ code: licCompute.replaceAll('@group(1)', '@group(0)'), label: 'sciviz LIC convolution' }), entryPoint: 'generate' } });
    this.#texture = colormapTexture(device, this.#map);
    this.#drawLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ] });
    this.#drawGroup = device.createBindGroup({ layout: this.#drawLayout, entries: [
      { binding: 0, resource: { buffer: this.#buffers[0] } }, { binding: 1, resource: { buffer: this.#buffers[2] } },
      { binding: 2, resource: this.#texture.createView() }, { binding: 3, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
    ] });
    this.#dirty = true;
  }
  /** @internal */
  restore(): void {
    if (this.#disposed) return;
    for (const b of this.#buffers) b.destroy(); this.#buffers = [];
    this.#texture?.destroy(); this.#build();
  }
  /** @internal */
  prepare(context: GpuContext): void {
    this.#device.queue.writeBuffer(this.#buffers[0], 0, this.#values);
    if (!this.#dirty) return;
    const pass = context.encoder.beginComputePass();
    pass.setPipeline(this.#compute); pass.setBindGroup(0, this.#computeGroup);
    pass.dispatchWorkgroups(Math.ceil(this.#resolution[0] / 8), Math.ceil(this.#resolution[1] / 8)); pass.end();
    this.#dirty = false;
  }
  /** @internal */
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    const pipeline = renderer.pipeline('lic', context, (target) => {
      const module = this.#device.createShaderModule({ code: licDraw, label: 'sciviz LIC slice' });
      return { layout: this.#device.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout!, this.#drawLayout] }),
        vertex: { module, entryPoint: 'vertex' }, fragment: { module, entryPoint: 'fragment', targets: [{ format: target.format,
          blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: target.depth, depthWriteEnabled: !this.transparent, depthCompare: 'greater-equal' }, multisample: target.multisample };
    });
    pass.setPipeline(pipeline); pass.setBindGroup(1, this.#drawGroup); pass.draw(6);
  }

  /**
   * Reads the generated image's luminance, x fastest, NaN for masked texels. Generates pending changes first.
   * Default timeout 30000 ms; abort rejects with the exact reason and always frees the staging buffer.
   */
  async readIntensity(options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}): Promise<Float32Array> {
    options.signal?.throwIfAborted(); this.#check();
    if (this.#renderer.device !== this.#device) throw fault('state', 'Await figure.ready() after LIC device replacement', 'sciviz');
    const timeout = options.timeoutMs ?? 30000;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647) fail('LIC readback timeoutMs must be positive and <=2147483647');
    const count = this.#resolution[0] * this.#resolution[1], device = this.#device;
    const buffer = device.createBuffer({ size: count * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    try {
      const encoder = device.createCommandEncoder();
      this.prepare({ encoder } as GpuContext);
      encoder.copyBufferToBuffer(this.#buffers[2], 0, buffer, 0, count * 16); device.queue.submit([encoder.finish()]);
      await Promise.race([buffer.mapAsync(GPUMapMode.READ), new Promise<never>((_, reject) => {
        abort = () => reject(options.signal!.reason); options.signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(fault('timeout', 'LIC readback timed out; check GPU/device state', 'sciviz')), timeout);
      })]);
      options.signal?.throwIfAborted(); this.#check();
      if (device !== this.#renderer.device) throw fault('state', 'Await figure.ready() after LIC device replacement', 'sciviz');
      const raw = new Float32Array(buffer.getMappedRange()), out = new Float32Array(count);
      for (let i = 0; i < count; i++) out[i] = raw[i * 4 + 2] > 0 ? raw[i * 4] : NaN;
      return out;
    } finally { if (timer !== undefined) clearTimeout(timer); if (abort) options.signal?.removeEventListener('abort', abort); buffer.destroy(); }
  }
  /** Frees GPU resources and retained data; idempotent. */
  dispose(): void {
    if (this.#disposed) return; this.#disposed = true; this.#renderer.remove(this);
    for (const b of this.#buffers) b.destroy(); this.#buffers = []; this.#texture?.destroy(); this.#texture = undefined;
    this.#field = new Float32Array();
  }
  [Symbol.dispose](): void { this.dispose(); }
}

/** Creates a GPU LIC layer, with an immutable field copy, in a 3D figure. WebGPU and webgl2-compat are supported. */
export function lic(figure: Figure, grid: VectorGrid, options: LicOptions = {}): Promise<LicLayer> {
  return LicLayer.create(figure, grid, options);
}
