/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { GpuArray, checkShape } from './array.js';
import { DTYPES, bytesOf, dtypeOf, type DType } from './dtype.js';
import { Expr, Operand, fuse, where, type AxisOptions, type OperandLike } from './expr.js';
import { reflectWGSL, encode, type BindingInfo, type HostValue, type ModuleInfo } from './wgsl.js';
import { WG, mapShader, type Operator } from './shaders.js';
import * as reduce from './reduce.js';
import * as scan from './scan.js';
import * as sort from './sort.js';
import * as select from './select.js';
import { histogram, type Histogram, type HistogramOptions } from './histogram.js';
import { Kernel } from './kernel.js';

declare const GPUBufferUsage: {
  STORAGE: number;
  COPY_SRC: number;
  COPY_DST: number;
  UNIFORM: number;
  MAP_READ: number;
  QUERY_RESOLVE: number;
  INDIRECT: number;
  VERTEX: number;
};
declare const GPUShaderStage: { COMPUTE: number };
declare const GPUMapMode: { READ: number };

/** Options for {@link createCompute}. */
export interface CreateComputeOptions {
  /** Reuse this engine's GPU device (WebGPU backend). Default: a headless device of the context's own. */
  readonly engine?: EngineKernel;
  /** Reuse this GPU device. Takes precedence over `engine`. */
  readonly device?: GPUDevice;
  /** Adapter choice for a device of the context's own. Default `'high-performance'`. */
  readonly powerPreference?: GPUPowerPreference;
  /** Abandons device creation: the promise rejects with the signal's reason. */
  readonly signal?: AbortSignal;
}

/** Waiting options: an AbortSignal. */
export interface WaitOptions {
  /** Abandons the wait: the promise rejects with the signal's reason. */
  readonly signal?: AbortSignal;
}

/** Options for creating arrays: element type and shape. */
export interface ArrayOptions<T extends DType = DType> {
  /** Element type. Default from the data's TypedArray, else `'f32'`. */
  readonly dtype?: T;
  /** Shape. Default `[data.length]`. */
  readonly shape?: readonly number[];
}

/** A resource a kernel binding accepts by name. */
export type BindingResource =
  | GpuArray
  | GPUBuffer
  | GPUBufferBinding
  | GPUTexture
  | GPUTextureView
  | GPUSampler
  | ArrayBufferView
  | HostValue;

/** GPU time of one pass, from `profile()`. */
export interface PassTiming {
  /** What ran: `eval`, `reduce`, `sort.local`, a kernel's entry point, ... */
  readonly label: string;
  /** GPU milliseconds between the pass's start and end timestamps. */
  readonly ms: number;
}

/** @internal A compiled program. */
export interface Program {
  readonly pipeline: GPUComputePipeline;
  readonly layouts: GPUBindGroupLayout[];
  readonly info: ModuleInfo;
  readonly entry: ModuleInfo['entryPoints'][number];
  readonly label: string;
}

/** @internal One dispatch: a program, its resources by binding name, and workgroups (or an indirect buffer). */
export interface Pass {
  readonly program: Program;
  readonly resources: Readonly<Record<string, BindingResource>>;
  readonly workgroups?: readonly [number, number, number];
  readonly indirect?: { readonly buffer: GPUBuffer; readonly offset: number };
}

/** @internal A buffer-to-buffer copy queued after the passes. */
export type Copy = readonly [GPUBuffer, number, GPUBuffer, number, number];

const PROGRAM_CACHE = 512;

const layoutEntry = (b: BindingInfo): GPUBindGroupLayoutEntry => {
  const base = { binding: b.binding, visibility: GPUShaderStage.COMPUTE };
  switch (b.resource) {
    case 'uniform':
    case 'storage':
    case 'read-only-storage':
      return { ...base, buffer: { type: b.resource } };
    case 'sampler':
      return { ...base, sampler: { type: b.sampler } };
    case 'storage-texture':
      return {
        ...base,
        storageTexture: {
          format: b.texture!.format!,
          access: b.texture!.access,
          viewDimension: b.texture!.viewDimension,
        },
      };
    default:
      return {
        ...base,
        texture: {
          sampleType: b.texture!.sampleType,
          viewDimension: b.texture!.viewDimension,
          multisampled: b.texture!.multisampled,
        },
      };
  }
};

/** Throws the signal's reason when it has aborted. */
export const aborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw signal.reason;
};

/** Resolves `work`, or rejects with the signal's reason as soon as it aborts. */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  aborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * GPU compute without the WebGPU boilerplate, NumPy style: N-dimensional typed arrays with views and broadcasting,
 * fused element-wise expressions, reductions along axes, statistics, scans, sorting, selection, histograms, and your
 * own WGSL kernels bound by name. More lives in tree-shakable entries: `@margoengine/compute/linalg` (matmul),
 * `/fft`, `/signal` (convolution), `/random` (counter-based RNG), `/stream` (data larger than GPU memory) and `/frame`
 * (kernels in an engine's frame). Create a context with {@link createCompute}; dispose it (`using gpu = await
 * createCompute()`) to free every array it made and, when it opened its own device, the device.
 *
 * Operations queue GPU work and return at once; anything that waits (`read`, `item`, `done`, `profile`) takes an
 * AbortSignal and rejects with a MargoError (`failed`) carrying the GPU's message when queued work failed (a WGSL
 * error in a kernel or expression, out of memory).
 */
export class ComputeContext {
  /** The GPU device the context runs on. */
  readonly device: GPUDevice;
  /** True when the context opened the device itself (and destroys it on dispose). */
  readonly ownsDevice: boolean;
  /** Resolves when the device is lost (also after an owned device is destroyed by dispose). */
  readonly lost: Promise<GPUDeviceLostInfo>;
  readonly #arrays = new Set<GpuArray>();
  readonly #programs = new Map<string, Program>();
  readonly #staging = new Set<GPUBuffer>();
  #errors: Promise<GPUError | null>[] = [];
  #disposed = false;
  // While profiling: the timestamps of each timed submit, read once the submits' error scopes have resolved.
  #timings: { staging: GPUBuffer; queries: GPUQuerySet; labels: string[] }[] | undefined;

  /** @internal Use {@link createCompute}. */
  constructor(device: GPUDevice, ownsDevice: boolean) {
    this.device = device;
    this.ownsDevice = ownsDevice;
    this.lost = device.lost;
  }

  /** True after `dispose()`. */
  get disposed(): boolean {
    return this.#disposed;
  }

  /** True when the device can run `f16` arrays (the `shader-f16` feature). */
  get f16(): boolean {
    return this.device.features.has('shader-f16');
  }

  /** @internal Throws after dispose. */
  check(): void {
    if (this.#disposed)
      throw fault('disposed', 'ComputeContext disposed; create a new one with createCompute()', 'compute');
  }

  #dtype(dtype: DType): void {
    if (!DTYPES.includes(dtype))
      throw typeError(`dtype must be 'f32', 'f16', 'i32' or 'u32', got ${String(dtype)}`, 'compute');
    if (dtype === 'f16' && !this.f16)
      throw fault('unsupported', "This GPU has no shader-f16 feature; use 'f32' arrays", 'compute');
  }

  /** @internal An array of `shape`, zero-filled (WebGPU clears new buffers), with extra buffer `usage` flags. */
  empty<T extends DType>(shape: readonly number[], dtype: T, usage = 0): GpuArray<T> {
    this.check();
    this.#dtype(dtype);
    const array = new GpuArray(this, dtype, shape, undefined, usage);
    this.#arrays.add(array as GpuArray);
    return array;
  }

  /**
   * A GPU array from data: a TypedArray (its type picks the dtype: floats `f32`, Float16Array `f16`, signed `i32`,
   * unsigned `u32`; Float64Array is converted to f32) or a plain array (`f32` unless `dtype` says otherwise), shaped
   * `shape` (default flat). The second argument may be just the dtype.
   * @example const m = gpu.array(new Float32Array(6), { shape: [2, 3] });  const u = gpu.array([1, 2, 3], 'u32');
   */
  array<T extends DType = 'f32'>(
    data: ArrayLike<number> | ArrayBufferView,
    options: ArrayOptions<T> | T = {},
  ): GpuArray<T> {
    const o = typeof options === 'string' ? { dtype: options } : options;
    if (typeof data !== 'object' || data === null || typeof (data as ArrayLike<number>).length !== 'number')
      throw typeError(
        'gpu.array takes a TypedArray or an array of numbers; use gpu.zeros(shape) for an empty array',
        'compute',
      );
    const values = data as ArrayLike<number>,
      dtype = (o.dtype ?? dtypeOf(values)) as T,
      shape = o.shape ?? [values.length];
    if (checkShape(shape).reduce((a, b) => a * b, 1) !== values.length)
      throw rangeError(`Shape [${shape.join(', ')}] does not hold ${values.length} elements`, 'compute');
    return this.empty(shape, dtype).write(values);
  }

  /**
   * A u32 array of `[x, y, z]` workgroup counts usable as an indirect dispatch argument (`kernel.run({ indirect })`),
   * which a GPU pass can fill (from a compaction's count, say) without a round trip to the CPU.
   */
  indirectArgs(workgroups: readonly [number, number, number] = [0, 1, 1]): GpuArray<'u32'> {
    return this.empty([3], 'u32', GPUBufferUsage.INDIRECT).write(workgroups);
  }

  /**
   * An array whose buffer can also feed draws (VERTEX and INDIRECT usage), for compute results the engine draws
   * straight from: particle positions, culled instance lists, indirect draw arguments.
   */
  drawable<T extends DType = 'f32'>(shape: number | readonly number[], dtype?: T): GpuArray<T> {
    return this.empty(
      typeof shape === 'number' ? [shape] : shape,
      (dtype ?? 'f32') as T,
      GPUBufferUsage.VERTEX | GPUBufferUsage.INDIRECT,
    );
  }

  /** Zeros of `shape` (a number for 1D). */
  zeros<T extends DType = 'f32'>(shape: number | readonly number[], dtype?: T): GpuArray<T> {
    return this.empty(typeof shape === 'number' ? [shape] : shape, (dtype ?? 'f32') as T);
  }

  /** Ones of `shape`. */
  ones<T extends DType = 'f32'>(shape: number | readonly number[], dtype?: T): GpuArray<T> {
    return this.full(shape, 1, dtype);
  }

  /** `value` everywhere in `shape`. */
  full<T extends DType = 'f32'>(shape: number | readonly number[], value: number, dtype?: T): GpuArray<T> {
    const dims = typeof shape === 'number' ? [shape] : shape;
    return this.#index(dims)
      .astype('f32')
      .mul(0)
      .add(value)
      .astype((dtype ?? 'f32') as T)
      .eval() as GpuArray<T>;
  }

  /** Evenly spaced values in [start, stop) by `step` (NumPy `arange`; `arange(5)` is 0..4, as u32). */
  arange<T extends DType = DType>(start: number, stop?: number, step = 1, dtype?: T): GpuArray<T> {
    if (stop === undefined) [start, stop] = [0, start];
    if (!Number.isFinite(start) || !Number.isFinite(stop) || !Number.isFinite(step) || step === 0)
      throw rangeError(
        `arange needs finite start and stop and a non-zero step, got ${start}, ${stop}, ${step}`,
        'compute',
      );
    const n = Math.max(0, Math.ceil((stop - start) / step));
    const integral = Number.isInteger(start) && Number.isInteger(step);
    const type = (dtype ?? (integral ? (start >= 0 && step > 0 ? 'u32' : 'i32') : 'f32')) as T;
    const i = this.#index([n]);
    const values =
      integral && type !== 'f32' && type !== 'f16'
        ? i.astype('i32').mul(step).add(start)
        : i.astype('f32').mul(step).add(start);
    return values.astype(type).eval() as GpuArray<T>;
  }

  /** `num` evenly spaced values from start to stop inclusive (NumPy `linspace`), f32. */
  linspace(start: number, stop: number, num = 50): GpuArray<'f32'> {
    if (!Number.isInteger(num) || num < 0)
      throw rangeError(`linspace num must be a whole number, got ${num}`, 'compute');
    const step = num > 1 ? (stop - start) / (num - 1) : 0;
    return this.#index([num]).astype('f32').mul(step).add(start).eval() as GpuArray<'f32'>;
  }

  /** The `n` x `n` identity matrix. */
  eye<T extends DType = 'f32'>(n: number, dtype?: T): GpuArray<T> {
    const i = this.#index([n, n]);
    return i
      .floorDiv(n)
      .eq(i.mod(n))
      .astype((dtype ?? 'f32') as T)
      .eval() as GpuArray<T>;
  }

  #index(shape: readonly number[]): Expr {
    this.check();
    return new Expr(this, { kind: 'index', dtype: 'u32', shape: checkShape(shape) });
  }

  /** NumPy `where(condition, a, b)`: a lazy expression taking `a` where the condition is non-zero, else `b`. */
  where(condition: Operand, a: OperandLike, b: OperandLike): Expr {
    return where(condition, a, b);
  }

  /** @internal Called by GpuArray.dispose. */
  forget(array: GpuArray): void {
    this.#arrays.delete(array);
  }

  /** @internal Registers an owning array for disposal with the context. */
  track(array: GpuArray): void {
    this.#arrays.add(array);
  }

  /** @internal Runs an expression (or copies a view) into a new contiguous array. */
  evaluate(operand: Operand): GpuArray {
    this.check();
    const out = this.empty(operand.shape, operand.dtype),
      n = out.size;
    if (n === 0) return out;
    const temporaries: GpuArray[] = [];
    const fused = fuse(operand, 0, this.maxStorage(1), temporaries);
    const code = `${fused.enables}${fused.declarations}@group(0) @binding(${fused.next}) var<storage, read_write> out: array<${fused.dtype}>;
@group(0) @binding(${fused.next + 1}) var<uniform> size: vec4u;
${fused.fn}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = (wid.x + wid.y * nwg.x) * 256u + lid;
  if (i >= size.x) { return; }
  out[i] = value(i);
}`;
    this.submit([
      {
        program: this.program(code, undefined, 'eval'),
        resources: { ...fused.resources, out, size: new Uint32Array([n, 0, 0, 0]) },
        workgroups: this.grid(Math.ceil(n / WG)),
      },
    ]);
    for (const t of temporaries) t.dispose();
    return out;
  }

  /** @internal Storage buffers a fused read may use, leaving `reserved` for the kernel's own buffers. */
  maxStorage(reserved: number): number {
    return Math.max(1, this.device.limits.maxStorageBuffersPerShaderStage - reserved);
  }

  /** @internal Writes bytes at an offset that is not 4-byte aligned (f16 runs) through a word-masking kernel. */
  writeUnaligned(buffer: GPUBuffer, at: number, bytes: Uint8Array): void {
    const start = at & ~3,
      end = Math.ceil((at + bytes.length) / 4) * 4,
      words = new Uint8Array(end - start),
      count = (end - start) / 4,
      mask = new Uint32Array(count);
    words.set(bytes, at - start);
    for (let k = at - start; k < at - start + bytes.length; k++) mask[k >> 2] |= 0xff << ((k & 3) * 8);
    const program = this.program(
      /* wgsl */ `@group(0) @binding(0) var<storage, read_write> dst: array<u32>;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read> keep: array<u32>;
@group(0) @binding(3) var<uniform> at: vec4u;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= at.y) { return; }
  let m = keep[id.x];
  dst[at.x + id.x] = (dst[at.x + id.x] & ~m) | (src[id.x] & m);
}`,
      undefined,
      'write',
    );
    const src = this.empty([count], 'u32').write(new Uint32Array(words.buffer)),
      keep = this.empty([count], 'u32').write(mask);
    this.submit([
      {
        program,
        resources: { dst: buffer, src, keep, at: new Uint32Array([start / 4, count, 0, 0]) },
        workgroups: [Math.ceil(count / 64), 1, 1],
      },
    ]);
    src.dispose();
    keep.dispose();
  }

  /**
   * Compiles a WGSL compute kernel. Its `@group @binding` resources are read from the source and bound by name, so no
   * bind group or pipeline layouts are written by hand. `entryPoint` picks one of several `@compute` functions; `label`
   * names the pipeline in GPU errors and `profile()` (default the entry point). WGSL errors are reported by the next
   * wait (`read`, `done`) as a MargoError (`failed`).
   */
  kernel(code: string, options: { readonly entryPoint?: string; readonly label?: string } = {}): Kernel {
    this.check();
    if (typeof code !== 'string') throw typeError('gpu.kernel takes WGSL source text', 'compute');
    return new Kernel(this, this.program(code, options.entryPoint, options.label));
  }

  /** @internal A compiled program, cached by source and entry point (least recently used out past 512). */
  program(code: string, entryPoint?: string, label?: string): Program {
    const key = `${entryPoint ?? ''}\n${code}`,
      cached = this.#programs.get(key);
    if (cached) {
      this.#programs.delete(key);
      this.#programs.set(key, cached);
      return cached;
    }
    const info = reflectWGSL(code);
    if (!info.entryPoints.length) throw typeError('Kernel WGSL has no @compute entry point', 'compute');
    const entry = entryPoint === undefined ? info.entryPoints[0] : info.entryPoints.find((e) => e.name === entryPoint);
    if (!entry || (entryPoint === undefined && info.entryPoints.length > 1))
      throw typeError(
        `Kernel entry point ${entryPoint ?? '(none given)'} not found; pass entryPoint, one of ${info.entryPoints.map((e) => e.name).join(', ')}`,
        'compute',
      );
    const groups = Math.max(-1, ...info.bindings.map((b) => b.group)) + 1,
      name = label ?? entry.name;
    const program = this.scoped(() => {
      const layouts = Array.from({ length: groups }, (_, g) =>
        this.device.createBindGroupLayout({ entries: info.bindings.filter((b) => b.group === g).map(layoutEntry) }),
      );
      const pipeline = this.device.createComputePipeline({
        label: name,
        layout: this.device.createPipelineLayout({ bindGroupLayouts: layouts }),
        compute: { module: this.device.createShaderModule({ code, label: name }), entryPoint: entry.name },
      });
      return { pipeline, layouts, info, entry, label: name };
    });
    this.#programs.set(key, program);
    if (this.#programs.size > PROGRAM_CACHE) this.#programs.delete(this.#programs.keys().next().value!);
    return program;
  }

  /** @internal Runs `work` inside validation and out-of-memory error scopes, reported by the next wait. */
  scoped<T>(work: () => T): T {
    this.device.pushErrorScope('validation');
    this.device.pushErrorScope('out-of-memory');
    try {
      return work();
    } finally {
      this.#errors.push(this.device.popErrorScope(), this.device.popErrorScope());
    }
  }

  /** @internal Bind groups for a pass; buffers made for plain values go to `temporary`. */
  bindGroups(
    program: Program,
    resources: Readonly<Record<string, BindingResource>>,
    temporary: GPUBuffer[],
  ): GPUBindGroup[] {
    const unknown = Object.keys(resources).find((name) => !program.info.bindings.some((b) => b.name === name));
    if (unknown !== undefined)
      throw typeError(
        `Kernel has no binding named ${unknown}; its bindings are ${program.info.bindings.map((b) => b.name).join(', ')}`,
        'compute',
      );
    return program.layouts.map((layout, g) =>
      this.device.createBindGroup({
        layout,
        entries: program.info.bindings
          .filter((b) => b.group === g)
          .map((b) => ({ binding: b.binding, resource: this.resource(b, resources[b.name], temporary) })),
      }),
    );
  }

  /** @internal Encodes passes into `encoder` (with timestamps while profiling); returns the temporary buffers. */
  encode(encoder: GPUCommandEncoder, passes: readonly Pass[]): GPUBuffer[] {
    const temporary: GPUBuffer[] = [];
    const timed = this.#timings && this.device.features.has('timestamp-query') && passes.length > 0;
    const queries = timed ? this.device.createQuerySet({ type: 'timestamp', count: passes.length * 2 }) : undefined;
    passes.forEach((pass, k) => {
      const groups = this.bindGroups(pass.program, pass.resources, temporary);
      const compute = encoder.beginComputePass(
        queries
          ? { timestampWrites: { querySet: queries, beginningOfPassWriteIndex: 2 * k, endOfPassWriteIndex: 2 * k + 1 } }
          : {},
      );
      compute.setPipeline(pass.program.pipeline);
      groups.forEach((group, g) => compute.setBindGroup(g, group));
      if (pass.indirect) compute.dispatchWorkgroupsIndirect(pass.indirect.buffer, pass.indirect.offset);
      else compute.dispatchWorkgroups(...(pass.workgroups as [number, number, number]));
      compute.end();
    });
    if (queries) {
      const size = passes.length * 16,
        resolve = this.device.createBuffer({ size, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
        staging = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      encoder.resolveQuerySet(queries, 0, passes.length * 2, resolve, 0);
      encoder.copyBufferToBuffer(resolve, 0, staging, 0, size);
      temporary.push(resolve);
      this.#staging.add(staging);
      // Mapped by profile() after its error-scope round trip (see #flush), long after the submit that follows.
      this.#timings!.push({ staging, queries, labels: passes.map((p) => p.program.label) });
    }
    return temporary;
  }

  /** @internal Encodes and submits passes in one command buffer, then queued copies. */
  submit(passes: readonly Pass[], copies: readonly Copy[] = []): void {
    this.check();
    let temporary: GPUBuffer[] = [];
    try {
      this.scoped(() => {
        const encoder = this.device.createCommandEncoder();
        temporary = this.encode(encoder, passes);
        for (const [src, srcOffset, dst, dstOffset, size] of copies)
          if (size) encoder.copyBufferToBuffer(src, srcOffset, dst, dstOffset, size);
        this.device.queue.submit([encoder.finish()]);
      });
    } finally {
      // Destroying after submit is safe: the GPU keeps a buffer alive until the work using it is done.
      for (const buffer of temporary) buffer.destroy();
    }
  }

  /** @internal The binding resource for one declared binding. */
  resource(b: BindingInfo, value: BindingResource | undefined, temporary: GPUBuffer[]): GPUBindingResource {
    if (value === undefined) throw typeError(`Kernel binding ${b.name} is missing; pass it in run()`, 'compute');
    if (value instanceof GpuArray) {
      value.check(this);
      if (!value.offset) return { buffer: value.buffer };
      const at = value.offset * bytesOf(value.dtype),
        align = this.device.limits.minStorageBufferOffsetAlignment;
      if (at % align)
        throw rangeError(
          `View ${b.name} starts at byte ${at}, not a multiple of ${align}; bind view.ascontiguous()`,
          'compute',
        );
      return { buffer: value.buffer, offset: at };
    }
    const isBuffer = typeof GPUBuffer !== 'undefined' && value instanceof GPUBuffer;
    if (b.resource === 'uniform' || b.resource === 'storage' || b.resource === 'read-only-storage') {
      if (isBuffer) return { buffer: value as GPUBuffer };
      if (
        typeof value === 'object' &&
        value !== null &&
        'buffer' in value &&
        !ArrayBuffer.isView(value) &&
        !Array.isArray(value)
      )
        return value as GPUBufferBinding;
      if (b.resource === 'storage')
        throw typeError(
          `Kernel binding ${b.name} is read_write; pass a GpuArray or GPUBuffer to keep its results`,
          'compute',
        );
      const bytes = this.bytesFor(b, value);
      const buffer = this.device.createBuffer({
        size: bytes.byteLength,
        usage: (b.resource === 'uniform' ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE) | GPUBufferUsage.COPY_DST,
      });
      temporary.push(buffer);
      this.device.queue.writeBuffer(buffer, 0, bytes);
      return { buffer };
    }
    if (b.resource === 'sampler') return value as GPUSampler;
    if (typeof GPUTexture !== 'undefined' && value instanceof GPUTexture)
      return value.createView({ dimension: b.texture!.viewDimension });
    return value as GPUTextureView;
  }

  /** @internal Bytes for a uniform or read-only storage binding given as a TypedArray or a plain value. */
  bytesFor(b: BindingInfo, value: BindingResource): Uint8Array<ArrayBuffer> {
    if (ArrayBuffer.isView(value)) {
      const source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        bytes = new Uint8Array(Math.max(16, Math.ceil(source.length / 16) * 16));
      bytes.set(source);
      return bytes;
    }
    if (!b.layout)
      throw typeError(
        `Kernel binding ${b.name} has a type (${b.type}) the kernel cannot lay out; pass bytes`,
        'compute',
      );
    return encode(b.layout, value as HostValue, b.name);
  }

  /** @internal Workgroups for `groups` 1D workgroups, folded into a 2D grid past the per-dimension limit. */
  grid(groups: number): [number, number, number] {
    const max = this.device.limits.maxComputeWorkgroupsPerDimension;
    if (groups <= max) return [Math.max(1, groups), 1, 1];
    const y = Math.ceil(groups / max);
    if (y > max) throw rangeError(`Compute array too large: ${groups} workgroups exceed ${max} x ${max}`, 'compute');
    return [Math.ceil(groups / y), y, 1];
  }

  /** @internal Reads bytes of a buffer once queued work is done; rejects on GPU errors, abort or disposal. */
  async readBytes(buffer: GPUBuffer, offset: number, size: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    this.check();
    aborted(signal);
    if (size === 0) {
      await this.#flush();
      return new ArrayBuffer(0);
    }
    const start = offset & ~3,
      end = Math.ceil((offset + size) / 4) * 4,
      staging = this.device.createBuffer({
        size: end - start,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
    this.#staging.add(staging);
    const abort = () => staging.destroy();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const encoder = this.device.createCommandEncoder();
      encoder.copyBufferToBuffer(buffer, start, staging, 0, end - start);
      this.device.queue.submit([encoder.finish()]);
      await this.#flush();
      await staging.mapAsync(GPUMapMode.READ);
      return staging.getMappedRange().slice(offset - start, offset - start + size);
    } catch (error) {
      if (this.#disposed)
        throw fault('disposed', 'ComputeContext disposed during a read; keep it alive until reads finish', 'compute');
      aborted(signal);
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      this.#staging.delete(staging);
      staging.destroy();
    }
  }

  // Waits for every error scope so far and throws the first GPU error as a MargoError. One more (empty) scope makes a
  // round trip to the GPU process even when nothing is pending. Callers ask for completion (onSubmittedWorkDone,
  // mapAsync) only after this resolves: asked for earlier, Chromium reports completion about 3 ms late even for
  // finished work; asked for after the round trip, about 0.3 ms (measured on Edge, docs/benchmarking.md "compute").
  async #flush(): Promise<void> {
    this.device.pushErrorScope('validation');
    const pending = [...this.#errors, this.device.popErrorScope()];
    this.#errors = [];
    const error = (await Promise.all(pending)).find((e) => e);
    if (error)
      throw fault(
        'failed',
        `GPU ${error.constructor?.name === 'GPUOutOfMemoryError' ? 'out of memory' : 'validation error'}: ${error.message.trim()}; fix the kernel WGSL or its bindings (or use smaller arrays)`,
        'compute',
      );
  }

  /** Resolves when every queued operation has finished on the GPU; rejects like `read` when one failed. */
  async done(options: WaitOptions = {}): Promise<void> {
    this.check();
    aborted(options.signal);
    await this.#flush();
    await abortable(this.device.queue.onSubmittedWorkDone(), options.signal);
  }

  /**
   * Runs `work` and resolves the GPU time of every pass it queued, measured with timestamp queries. Resolves an
   * empty list on a device without the `timestamp-query` feature.
   * @example const timings = await gpu.profile(() => gpu.sort(keys)); // [{ label: 'sort.local', ms: 0.12 }, ...]
   */
  async profile(work: () => unknown, options: WaitOptions = {}): Promise<PassTiming[]> {
    this.check();
    if (this.#timings) throw fault('state', 'profile() is already running; await it before profiling again', 'compute');
    this.#timings = [];
    let pending: { staging: GPUBuffer; queries: GPUQuerySet; labels: string[] }[] = [];
    try {
      try {
        await work();
      } finally {
        pending = this.#timings!;
        this.#timings = undefined;
      }
      await this.#flush();
      const read = async ({ staging, labels }: (typeof pending)[number]) => {
        await staging.mapAsync(GPUMapMode.READ);
        const ticks = new BigUint64Array(staging.getMappedRange().slice(0));
        return labels.map((label, k) => ({ label, ms: Number(ticks[2 * k + 1] - ticks[2 * k]) / 1e6 }));
      };
      return (await abortable(Promise.all(pending.map(read)), options.signal)).flat();
    } finally {
      for (const { staging, queries } of pending) {
        this.#staging.delete(staging);
        staging.destroy();
        queries.destroy();
      }
    }
  }

  /**
   * Element-wise map with a WGSL expression: one input is named `x`, several are passed as an object and named by
   * their keys; `i` is the flat index and `n` the size. An expression containing `return` is a function body. The
   * inputs share one shape. `dtype` is the output type, default the first input's; `label` names the pass (default
   * `'map'`). (Element-wise methods such as
   * `x.mul(2).add(1)` fuse the same way without WGSL.)
   * @example const y = gpu.map(x, 'x * x + 1.0');  const d = gpu.map({ a, b }, 'abs(a - b)');
   */
  map<T extends DType = DType>(
    inputs: Operand | Readonly<Record<string, Operand>>,
    expression: string,
    options: { readonly dtype?: T; readonly label?: string } = {},
  ): GpuArray<T> {
    this.check();
    const named = inputs instanceof Operand ? { x: inputs } : inputs;
    const names = Object.keys(named);
    if (!names.length) throw typeError('gpu.map needs at least one input array', 'compute');
    for (const name of names)
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        ['i', 'n', 'f', 'main', 'out', 'params'].includes(name) ||
        name.startsWith('in_')
      )
        throw typeError(`gpu.map input name ${name} is not a usable WGSL name; rename it`, 'compute');
    if (typeof expression !== 'string' || !expression.trim())
      throw typeError('gpu.map needs a WGSL expression', 'compute');
    const arrays = names.map((k) => {
      const a = named[k];
      if (!(a instanceof Operand)) throw typeError(`gpu.map input ${k} must be a GpuArray or an Expr`, 'compute');
      return a instanceof GpuArray && a.contiguous && a.offset === 0 ? a : a.eval();
    });
    const shape = arrays[0].shape,
      n = arrays[0].size;
    if (arrays.some((a) => a.shape.length !== shape.length || a.shape.some((d, k) => d !== shape[k])))
      throw rangeError(
        `gpu.map inputs must share one shape, got ${arrays.map((a) => `[${a.shape.join(', ')}]`).join(', ')}`,
        'compute',
      );
    const dtype = (options.dtype ?? arrays[0].dtype) as T,
      out = this.empty(shape, dtype);
    if (n > 0) {
      const code = mapShader(
        names.map((name, k) => ({ name, type: arrays[k].dtype })),
        dtype,
        expression,
      );
      const resources: Record<string, BindingResource> = { out, params: new Uint32Array([n, 0x7f800000, 0, 0]) };
      names.forEach((name, k) => (resources[`in_${name}`] = arrays[k]));
      this.submit([
        {
          program: this.program(code, undefined, options.label ?? 'map'),
          resources,
          workgroups: this.grid(Math.ceil(n / WG)),
        },
      ]);
    }
    names.forEach((k, j) => arrays[j] !== named[k] && arrays[j].dispose());
    return out;
  }

  /**
   * Folds elements with `op` (`'sum'`, `'product'`, `'min'`, `'max'`, or WGSL `{ combine: 'a + b', identity: '0.0' }`)
   * over every element or along `axis`, fused with the expression it reads. Returns an array (shape `[]` for a full
   * reduction; `await r.item()` reads the value). Integer sums wrap at 32 bits.
   */
  reduce(input: Operand, op: Operator = 'sum', options: AxisOptions = {}): GpuArray {
    return reduce.reduce(this, input, op, options);
  }
  /** Sum (NumPy `sum`). */ sum(input: Operand, options?: AxisOptions): GpuArray {
    return reduce.reduce(this, input, 'sum', options);
  }
  /** Product. */ prod(input: Operand, options?: AxisOptions): GpuArray {
    return reduce.reduce(this, input, 'product', options);
  }
  /** Minimum. */ min(input: Operand, options?: AxisOptions): GpuArray {
    return reduce.reduce(this, input, 'min', options);
  }
  /** Maximum. */ max(input: Operand, options?: AxisOptions): GpuArray {
    return reduce.reduce(this, input, 'max', options);
  }
  /** Mean, in f32. */ mean(input: Operand, options?: AxisOptions): GpuArray {
    return reduce.mean(this, input, options);
  }
  /** Variance with `ddof` (default 0), in f32, in two passes (mean, then squared deviations). */
  var(input: Operand, options?: AxisOptions & { readonly ddof?: number }): GpuArray {
    return reduce.variance(this, input, options);
  }
  /** Standard deviation with `ddof` (default 0), in f32. */
  std(input: Operand, options?: AxisOptions & { readonly ddof?: number }): GpuArray {
    return reduce.std(this, input, options);
  }
  /** Index of the minimum (first on ties), flat or along one axis. */
  argmin(input: Operand, options?: { readonly axis?: number; readonly keepdims?: boolean }): GpuArray<'u32'> {
    return reduce.arg(this, input, 'min', options);
  }
  /** Index of the maximum (first on ties), flat or along one axis. */
  argmax(input: Operand, options?: { readonly axis?: number; readonly keepdims?: boolean }): GpuArray<'u32'> {
    return reduce.arg(this, input, 'max', options);
  }
  /** 1 when every element is non-zero (u32). */ all(input: Operand, options?: AxisOptions): GpuArray {
    return reduce.reduce(this, input.ne(0), 'min', options);
  }
  /** 1 when any element is non-zero (u32). */ any(input: Operand, options?: AxisOptions): GpuArray {
    return reduce.reduce(this, input.ne(0), 'max', options);
  }
  /** Number of non-zero elements (u32). */ countNonzero(input: Operand, options?: AxisOptions): GpuArray {
    return reduce.reduce(this, input.ne(0), 'sum', options);
  }
  /** Sum ignoring NaN. */ nansum(input: Operand, options?: AxisOptions): GpuArray {
    return reduce.reduce(this, where(input.isnan(), 0, input), 'sum', options);
  }
  /** Minimum ignoring NaN (+Infinity when every element is NaN). */ nanmin(
    input: Operand,
    options?: AxisOptions,
  ): GpuArray {
    return reduce.reduce(this, where(input.isnan(), Infinity, input), 'min', options);
  }
  /** Maximum ignoring NaN (-Infinity when every element is NaN). */ nanmax(
    input: Operand,
    options?: AxisOptions,
  ): GpuArray {
    return reduce.reduce(this, where(input.isnan(), -Infinity, input), 'max', options);
  }
  /** Mean ignoring NaN, in f32. */ nanmean(input: Operand, options?: AxisOptions): GpuArray {
    return reduce.nanmean(this, input, options);
  }

  /**
   * Prefix scan with `op` (default sum): element i combines elements 0..i (inclusive, the default) or 0..i-1
   * (`exclusive`), over the flat array or along `axis` (each line on its own). `scan(a)` is NumPy's `cumsum`.
   */
  scan(input: Operand, options: scan.ScanOptions = {}): GpuArray {
    return scan.scan(this, input, options);
  }
  /** Inclusive sum along `axis` (default flat), NumPy `cumsum`. */
  cumsum(input: Operand, options: { readonly axis?: number } = {}): GpuArray {
    return scan.scan(this, input, options);
  }
  /** Inclusive product along `axis`, NumPy `cumprod`. */
  cumprod(input: Operand, options: { readonly axis?: number } = {}): GpuArray {
    return scan.scan(this, input, { ...options, op: 'product' });
  }
  /** Scan restarting where `flags` is non-zero (a new segment starts at that element). Inclusive unless `exclusive`. */
  segmentedScan(values: Operand, flags: Operand, options: Omit<scan.ScanOptions, 'axis'> = {}): GpuArray {
    return scan.segmented(this, values, flags, options);
  }
  /**
   * Group-by on runs of equal consecutive keys (sort first to group all equal keys): resolves the distinct keys and
   * each run's values folded with `op` (default sum).
   */
  reduceByKey(
    keys: Operand,
    values: Operand,
    options: { readonly op?: Operator } & WaitOptions = {},
  ): Promise<{ keys: GpuArray; values: GpuArray }> {
    return scan.reduceByKey(this, keys, values, options);
  }

  /** A sorted copy of the flat elements (ascending, or `descending`), stable. Floats: -Infinity first, NaN by sign bit. */
  sort(input: Operand, options: sort.SortOptions = {}): GpuArray {
    return sort.sort(this, input, options);
  }
  /** The flat indices that sort the input (u32), stable, like NumPy's `argsort`. */
  argsort(input: Operand, options: sort.SortOptions = {}): GpuArray<'u32'> {
    return sort.argsort(this, input, options);
  }
  /** Sorts `keys` and moves `values` (any type, same size) with them. Returns new arrays. */
  sortByKey(
    keys: Operand,
    values: Operand,
    options: sort.SortOptions = {},
  ): { readonly keys: GpuArray; readonly values: GpuArray } {
    return sort.sortByKey(this, keys, values, options);
  }
  /** The `k` largest (or with `largest: false`, smallest) values and their flat indices, in order. */
  topk(
    input: Operand,
    k: number,
    options: { readonly largest?: boolean } = {},
  ): { readonly values: GpuArray; readonly indices: GpuArray<'u32'> } {
    return sort.topk(this, input, k, options);
  }
  /** Quantiles `q` in [0, 1] (a number, or a list for several) with NumPy's default linear interpolation, f32. */
  quantile(input: Operand, q: number | readonly number[]): GpuArray<'f32'> {
    return sort.quantile(this, input, q);
  }
  /** Median (the 0.5 quantile), f32, shape `[]`. */
  median(input: Operand): GpuArray<'f32'> {
    return sort.quantile(this, input, 0.5);
  }
  /** The distinct values in ascending order, and with `counts: true` how often each occurs. Reads the count back. */
  unique(
    input: Operand,
    options: { readonly counts?: boolean } & WaitOptions = {},
  ): Promise<{ values: GpuArray; counts?: GpuArray<'u32'> }> {
    return sort.unique(this, input, options);
  }

  /** Elements at `indices` (flat, or along `axis`), NumPy `take`; out-of-range indices clip (or `mode: 'wrap'`). */
  take(input: Operand, indices: Operand, options: select.TakeOptions = {}): GpuArray {
    return select.take(this, input, indices, options);
  }
  /**
   * Writes `values` into `target` at flat `indices`, in place. `op` `'set'` (one of several writes to an index wins),
   * `'add'`, `'min'` or `'max'` (duplicates combine atomically, f32 included). Returns `target`.
   */
  scatter<T extends DType>(
    target: GpuArray<T>,
    indices: Operand,
    values: OperandLike,
    options: { readonly op?: 'set' | 'add' | 'min' | 'max' } = {},
  ): GpuArray<T> {
    return select.scatter(this, target, indices, values, options);
  }
  /** How often each value occurs in a non-negative integer array (NumPy `bincount`), or the sum of `weights` per value. */
  bincount(input: Operand, options: { readonly weights?: Operand; readonly length: number }): GpuArray {
    return select.bincount(this, input, options);
  }
  /**
   * Stream compaction without reading back: the elements whose mask is non-zero, packed at the front of `values`
   * (capacity: the input size), and their `count` (u32, shape [1]) for an indirect dispatch or a later read.
   */
  compact(input: Operand, mask: Operand): { readonly values: GpuArray; readonly count: GpuArray<'u32'> } {
    return select.compact(this, input, mask);
  }
  /** The elements whose mask is non-zero, as an exactly sized array (reads the count back). */
  filter(input: Operand, mask: Operand, options: WaitOptions = {}): Promise<GpuArray> {
    return select.filter(this, input, mask, options);
  }
  /** Flat indices of the non-zero elements (u32), NumPy `flatnonzero`. Reads the count back. */
  nonzero(input: Operand, options: WaitOptions = {}): Promise<GpuArray<'u32'>> {
    return select.nonzero(this, input, options);
  }

  /**
   * Counts values in equal bins over `range` (default the data's own min and max, found on the GPU: nothing is read
   * back), like NumPy's `histogram`: the last bin includes the maximum; values outside and NaN are not counted.
   */
  histogram(input: Operand, options: HistogramOptions = {}): Histogram {
    return histogram(this, input, options);
  }

  /** Frees every array the context made, rejects pending reads, and destroys the device when the context opened it. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const array of [...this.#arrays]) array.dispose();
    for (const staging of this.#staging) staging.destroy();
    this.#programs.clear();
    if (this.ownsDevice) this.device.destroy();
  }

  /** Same as `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/**
 * Opens a compute context. With `engine` (WebGPU backend) or `device` it shares that device; otherwise it opens a
 * headless device of its own with the adapter's largest buffer limits (so big arrays fit) and, where available, the
 * `shader-f16` and `timestamp-query` features. Rejects with a MargoError (`unsupported`) without WebGPU.
 * @example
 * using gpu = await createCompute();
 * const sorted = await gpu.sort(gpu.array([3, 1, 2])).read(); // Float32Array [1, 2, 3]
 */
export async function createCompute(options: CreateComputeOptions = {}): Promise<ComputeContext> {
  aborted(options.signal);
  if (options.device) return new ComputeContext(options.device, false);
  if (options.engine) {
    const device = (options.engine as unknown as { gpu: GPUDevice | null }).gpu;
    if (!device)
      throw fault(
        'unsupported',
        'Engine has no WebGPU device (WebGL2 fallback); create the context without an engine',
        'compute',
      );
    return new ComputeContext(device, false);
  }
  const gpu = (globalThis.navigator as Navigator | undefined)?.gpu;
  if (!gpu) throw fault('unsupported', 'WebGPU unavailable; use a browser or runtime with WebGPU', 'compute');
  const adapter = await abortable(
    gpu.requestAdapter({ powerPreference: options.powerPreference ?? 'high-performance' }),
    options.signal,
  );
  if (!adapter) throw fault('unsupported', 'WebGPU adapter unavailable; check that the GPU is enabled', 'compute');
  const wanted: GPUFeatureName[] = ['shader-f16', 'timestamp-query'];
  const device = await adapter.requestDevice({
    requiredFeatures: wanted.filter((f) => adapter.features.has(f)),
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
      maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
    },
  });
  if (options.signal?.aborted) {
    device.destroy();
    throw options.signal.reason;
  }
  return new ComputeContext(device, true);
}
