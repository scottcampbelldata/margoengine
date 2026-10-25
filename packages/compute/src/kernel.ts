// Your own WGSL kernels, bound by name. `run` binds and submits in one call; `bind` keeps the bind groups and uniform
// buffers so a kernel that runs every frame costs one dispatch and, for changed uniforms, one buffer write.
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { GpuArray } from './array.js';
import type { BindingInfo } from './wgsl.js';
import type { BindingResource, ComputeContext, Program } from './context.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number; INDIRECT: number };

/** How many threads (`count`), workgroups, or an indirect argument buffer a kernel run dispatches. */
export interface RunOptions {
  /** Threads to cover, up to three dimensions; rounded up to whole workgroups of the entry point's `@workgroup_size`. */
  readonly count?: number | readonly [number, number?, number?];
  /** Workgroups to dispatch, as `dispatchWorkgroups` takes them. */
  readonly workgroups?: number | readonly [number, number?, number?];
  /**
   * Workgroup counts read on the GPU from three u32 at element `indirectOffset` of this array (an array with INDIRECT
   * usage: create it with `kernel.indirectArgs()`), so a previous pass (a compaction, a culling count) sizes this one.
   */
  readonly indirect?: GpuArray<'u32'> | GPUBuffer;
  /** Element offset of the three counts in `indirect`. Default 0. */
  readonly indirectOffset?: number;
}

type Dims = [number, number, number];

/** @internal The dispatch for `options`: workgroups, or an indirect buffer and byte offset. */
function dispatchOf(
  context: ComputeContext,
  size: readonly [number, number, number],
  options: RunOptions,
): { workgroups?: Dims; indirect?: { buffer: GPUBuffer; offset: number } } {
  if (options.indirect) {
    const buffer = options.indirect instanceof GpuArray ? options.indirect.buffer : options.indirect;
    const offset =
      (options.indirectOffset ?? 0) * 4 + (options.indirect instanceof GpuArray ? options.indirect.offset * 4 : 0);
    if (!Number.isInteger(offset) || offset < 0)
      throw rangeError('indirectOffset must be a whole number of elements', 'compute');
    return { indirect: { buffer, offset } };
  }
  const dims = (value: number | readonly [number, number?, number?]): Dims =>
    typeof value === 'number' ? [value, 1, 1] : [value[0], value[1] ?? 1, value[2] ?? 1];
  let workgroups: Dims;
  if (options.workgroups !== undefined) workgroups = dims(options.workgroups);
  else if (options.count !== undefined) workgroups = dims(options.count).map((c, k) => Math.ceil(c / size[k])) as Dims;
  else throw typeError('Kernel run needs count (threads), workgroups or indirect', 'compute');
  const max = context.device.limits.maxComputeWorkgroupsPerDimension;
  for (const w of workgroups)
    if (!Number.isInteger(w) || w < 0 || w > max)
      throw rangeError(
        `Kernel run of ${workgroups.join(' x ')} workgroups is over ${max} per dimension; spread the work over y and z`,
        'compute',
      );
  return { workgroups };
}

/** A compiled WGSL compute kernel whose resources are bound by name. Create it with `gpu.kernel(code)`. */
export class Kernel {
  /** The kernel's `@group @binding` resources, read from its source. */
  readonly bindings: readonly BindingInfo[];
  /** The entry point it runs. */
  readonly entryPoint: string;
  /** The entry point's `@workgroup_size`. */
  readonly workgroupSize: readonly [number, number, number];
  readonly #context: ComputeContext;
  readonly #program: Program;
  #disposed = false;

  /** @internal Use `gpu.kernel(code)`. */
  constructor(context: ComputeContext, program: Program) {
    this.#context = context;
    this.#program = program;
    this.bindings = program.info.bindings;
    this.entryPoint = program.entry.name;
    this.workgroupSize = program.entry.workgroupSize;
  }

  #check(): void {
    if (this.#disposed) throw fault('disposed', 'Kernel disposed; compile it again with gpu.kernel()', 'compute');
  }

  /**
   * Queues one dispatch. `resources` maps binding names to GpuArrays, GPU buffers, textures, samplers, bytes, or plain
   * values for uniform structs (laid out from the WGSL declaration). Returns the kernel, so runs chain.
   * @example kernel.run({ src, dst, params: { scale: 2, count: n } }, { count: n });
   */
  run(resources: Readonly<Record<string, BindingResource>>, options: RunOptions): this {
    this.#check();
    const dispatch = dispatchOf(this.#context, this.workgroupSize, options);
    if (dispatch.indirect || dispatch.workgroups!.every((w) => w > 0))
      this.#context.submit([{ program: this.#program, resources: { ...resources }, ...dispatch }]);
    return this;
  }

  /**
   * Binds resources once for repeated runs: the bind groups and the buffers holding plain uniform values are kept, so
   * each `run` (or `encode` into your own command encoder) is one dispatch. Change a uniform with `set`.
   */
  bind(resources: Readonly<Record<string, BindingResource>>): BoundKernel {
    this.#check();
    return new BoundKernel(this.#context, this.#program, resources);
  }

  /** A u32 array of `[x, y, z]` workgroup counts with INDIRECT usage, for `run({ indirect })`. */
  indirectArgs(workgroups: readonly [number, number, number] = [0, 1, 1]): GpuArray<'u32'> {
    this.#check();
    return this.#context.indirectArgs(workgroups);
  }

  /** Releases the kernel. Running it afterwards throws a MargoError (`disposed`). */
  dispose(): void {
    this.#disposed = true;
  }

  /** Same as `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** A kernel with its resources bound, for runs every frame. Create it with `kernel.bind(resources)`. */
export class BoundKernel {
  readonly #context: ComputeContext;
  readonly #program: Program;
  readonly #resources: Record<string, BindingResource>;
  readonly #owned = new Map<string, GPUBuffer>();
  #groups: GPUBindGroup[] | undefined;
  #disposed = false;

  /** @internal Use `kernel.bind(resources)`. */
  constructor(context: ComputeContext, program: Program, resources: Readonly<Record<string, BindingResource>>) {
    this.#context = context;
    this.#program = program;
    this.#resources = { ...resources };
    this.#build();
  }

  #build(): void {
    for (const buffer of this.#owned.values()) buffer.destroy();
    this.#owned.clear();
    const temporary: GPUBuffer[] = [];
    // Plain values become buffers owned by this binding, so `set` can rewrite them in place.
    const resources: Record<string, BindingResource> = { ...this.#resources };
    for (const b of this.#program.info.bindings) {
      const value = resources[b.name];
      if (!this.#plain(b, value)) continue;
      const bytes = this.#context.bytesFor(b, value!);
      const buffer = this.#context.device.createBuffer({
        size: bytes.byteLength,
        usage: (b.resource === 'uniform' ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE) | GPUBufferUsage.COPY_DST,
      });
      this.#context.device.queue.writeBuffer(buffer, 0, bytes);
      this.#owned.set(b.name, buffer);
      resources[b.name] = buffer;
    }
    this.#groups = this.#context.scoped(() => this.#context.bindGroups(this.#program, resources, temporary));
  }

  #plain(b: BindingInfo, value: BindingResource | undefined): boolean {
    if (b.resource !== 'uniform' && b.resource !== 'read-only-storage') return false;
    if (value === undefined || value instanceof GpuArray) return false;
    if (typeof GPUBuffer !== 'undefined' && value instanceof GPUBuffer) return false;
    return !(
      typeof value === 'object' &&
      value !== null &&
      'buffer' in value &&
      !ArrayBuffer.isView(value) &&
      !Array.isArray(value)
    );
  }

  /**
   * Changes one binding. A plain uniform value of the same size is written into the existing buffer (no new bind
   * group); anything else rebinds.
   */
  set(name: string, value: BindingResource): this {
    if (this.#disposed) throw fault('disposed', 'BoundKernel disposed; bind the kernel again', 'compute');
    const b = this.#program.info.bindings.find((x) => x.name === name);
    if (!b) throw typeError(`Kernel has no binding named ${name}`, 'compute');
    const owned = this.#owned.get(name);
    if (owned && this.#plain(b, value)) {
      const bytes = this.#context.bytesFor(b, value);
      if (bytes.byteLength === owned.size) {
        this.#context.device.queue.writeBuffer(owned, 0, bytes);
        this.#resources[name] = value;
        return this;
      }
    }
    this.#resources[name] = value;
    this.#build();
    return this;
  }

  /** Records the dispatch into `encoder` (an engine frame's encoder, or your own). */
  encode(encoder: GPUCommandEncoder | GPUComputePassEncoder, options: RunOptions): void {
    if (this.#disposed) throw fault('disposed', 'BoundKernel disposed; bind the kernel again', 'compute');
    for (const value of Object.values(this.#resources)) if (value instanceof GpuArray) value.check(this.#context);
    const dispatch = dispatchOf(this.#context, this.#program.entry.workgroupSize, options);
    if (dispatch.workgroups && !dispatch.workgroups.every((w) => w > 0)) return;
    const own = 'beginComputePass' in encoder;
    const pass = own
      ? (encoder as GPUCommandEncoder).beginComputePass({ label: this.#program.label })
      : (encoder as GPUComputePassEncoder);
    pass.setPipeline(this.#program.pipeline);
    this.#groups!.forEach((group, g) => pass.setBindGroup(g, group));
    if (dispatch.indirect) pass.dispatchWorkgroupsIndirect(dispatch.indirect.buffer, dispatch.indirect.offset);
    else pass.dispatchWorkgroups(...dispatch.workgroups!);
    if (own) pass.end();
  }

  /** Submits one dispatch. Returns this binding, so runs chain. */
  run(options: RunOptions): this {
    this.#context.check();
    this.#context.scoped(() => {
      const encoder = this.#context.device.createCommandEncoder();
      this.encode(encoder, options);
      this.#context.device.queue.submit([encoder.finish()]);
    });
    return this;
  }

  /** Frees the buffers holding plain values. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const buffer of this.#owned.values()) buffer.destroy();
    this.#owned.clear();
    this.#groups = undefined;
  }

  /** Same as `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
