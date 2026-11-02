// Internal J6 transport, derived from Margo's J5 transport, not another engine.
// WebGPU CRD 2026-09-15 https://www.w3.org/TR/2026/CRD-webgpu-20260915/
// #buffer-mapping, #computepass, #error-scopes, #dom-gpudevice-lost:
// ordered dispatch/readback, validation scopes and loss notification. These prove no numerical parity.
import { fault, rangeError } from '../../shared/errors.js';
import { divFloor } from './fixed.js';

declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number; COPY_SRC: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };

/** Internal, bounded 64-lane dispatch geometry, with no empty dispatch. */
export function dispatchShape(device: GPUDevice, n: number): [number, number] {
  const limit = device.limits.maxComputeWorkgroupsPerDimension;
  if (!Number.isSafeInteger(n) || n < 1 || n > 2147483647 || !(limit >= 1))
    throw rangeError('GPU work needs 1..2147483647 invocations and valid device limits', 'biomes');
  const x = Math.min(Math.ceil(n / 64), limit),
    y = -divFloor(-n, 64 * x);
  if (y > limit) throw rangeError('GPU work exceeds dispatch limits; use a smaller input', 'biomes');
  if (!(device.limits.maxComputeInvocationsPerWorkgroup >= 64) || !(device.limits.maxComputeWorkgroupSizeX >= 64))
    throw rangeError('GPU work needs 64 compute invocations per workgroup', 'biomes');
  return [x, y];
}

/** Validate every storage allocation before creating a session or touching the device. */
export function checkWords(device: GPUDevice, words: number): void {
  const bytes = Math.max(4, words * 4);
  if (
    !Number.isSafeInteger(words) ||
    words < 0 ||
    bytes > device.limits.maxBufferSize ||
    bytes > device.limits.maxStorageBufferBindingSize ||
    !(device.limits.maxBufferSize >= 4) ||
    !(device.limits.maxStorageBufferBindingSize >= 4)
  )
    throw rangeError('GPU storage exceeds device limits; use a smaller input', 'biomes');
}

/** One request owns all buffers and failure listeners, including across dependent submissions. */
export class ComputeSession {
  readonly buffers: GPUBuffer[] = [];
  readonly pending: Promise<unknown>[] = [];
  readonly failure: Promise<never>;
  readonly reject: (reason: unknown) => void;
  readonly abort = () => this.reject(this.signal!.reason);
  readonly uncaptured = (event: Event) =>
    this.reject(
      fault(
        'failed',
        `GPU placement/flow error: ${(event as GPUUncapturedErrorEvent).error.message}; recreate the WebGPU device`,
        'biomes',
      ),
    );
  constructor(
    readonly device: GPUDevice,
    readonly signal?: AbortSignal,
  ) {
    let reject!: (reason: unknown) => void;
    this.failure = new Promise<never>((_, fail) => {
      reject = fail;
    });
    this.reject = reject;
    void this.failure.catch(() => {});
    device.addEventListener('uncapturederror', this.uncaptured);
    signal?.addEventListener('abort', this.abort, { once: true });
    void device.lost.then(
      (loss) => reject(fault('failed', `GPU device lost: ${loss.message}; recreate the WebGPU device`, 'biomes')),
      reject,
    );
    signal?.throwIfAborted();
  }
  wait<T>(task: Promise<T>): Promise<T> {
    this.pending.push(task);
    return Promise.race([task, this.failure]);
  }
  async scoped<T>(work: () => T): Promise<Awaited<T>> {
    this.signal?.throwIfAborted();
    this.device.pushErrorScope('validation');
    let value: T;
    let scope!: Promise<GPUError | null>;
    try {
      value = work();
    } finally {
      scope = this.device.popErrorScope();
      this.pending.push(scope);
    }
    const [result, error] = await this.wait(Promise.all([Promise.resolve(value!), scope]));
    if (error) throw fault('failed', `GPU validation failed: ${error.message}; check device limits`, 'biomes');
    this.signal?.throwIfAborted();
    return result as Awaited<T>;
  }
  async pipelines(code: string, names: readonly string[]): Promise<GPUComputePipeline[]> {
    return this.scoped(async () => {
      const module = this.device.createShaderModule({ code });
      const compilation = module.getCompilationInfo();
      this.pending.push(compilation);
      const tasks: Promise<GPUComputePipeline>[] = [];
      for (const entryPoint of names) {
        const task = this.device.createComputePipelineAsync({
          layout: 'auto',
          compute: { module, entryPoint },
        });
        tasks.push(task);
        this.pending.push(task);
      }
      const [info, pipelines] = await Promise.all([compilation, Promise.all(tasks)]);
      if (info.messages.length)
        throw fault(
          'failed',
          `GPU compilation failed: ${info.messages.map((m) => m.message).join('; ')}; check WGSL support`,
          'biomes',
        );
      return pipelines;
    });
  }
  buffer(words: number, data?: Int32Array | Uint32Array, readback = false): GPUBuffer {
    checkWords(this.device, words);
    const buffer = this.device.createBuffer({
      size: Math.max(4, words * 4),
      usage: readback
        ? GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        : GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.buffers.push(buffer);
    if (data?.length) this.device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }
  dispatch(encoder: GPUCommandEncoder, pipeline: GPUComputePipeline, buffers: readonly GPUBuffer[], n: number): void {
    const group = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(...dispatchShape(this.device, n));
    pass.end();
  }
  async read(buffer: GPUBuffer, words: number, encode?: (encoder: GPUCommandEncoder) => void): Promise<Int32Array> {
    const staging = await this.scoped(() => {
      const staging = this.buffer(words, undefined, true),
        encoder = this.device.createCommandEncoder();
      encode?.(encoder);
      encoder.copyBufferToBuffer(buffer, 0, staging, 0, words * 4);
      this.device.queue.submit([encoder.finish()]);
      return staging;
    });
    await this.wait(staging.mapAsync(GPUMapMode.READ));
    this.signal?.throwIfAborted();
    const result = new Int32Array(staging.getMappedRange()).slice();
    staging.unmap();
    // Readbacks are not retained across long flow dependency chains.
    staging.destroy();
    this.buffers.splice(this.buffers.indexOf(staging), 1);
    return result;
  }
  close(): void {
    void Promise.allSettled(this.pending);
    this.signal?.removeEventListener('abort', this.abort);
    this.device.removeEventListener('uncapturederror', this.uncaptured);
    for (const buffer of this.buffers) buffer.destroy();
  }
}

/** Every logical lane must have executed in every required round. */
export function markers(values: Int32Array, offset: number, n: number, rounds = 1): void {
  for (let i = 0; i < n; i++)
    if (values[offset + i] !== rounds)
      throw fault('failed', 'GPU left invocations unwritten; check shader dispatch dimensions', 'biomes');
}

/** Preserve caller cancellation and coded failures; turn device API failures into actionable errors. */
export function computeError(error: unknown, signal?: AbortSignal): never {
  signal?.throwIfAborted();
  if ((error as Error)?.name === 'MargoError') throw error;
  throw fault(
    'failed',
    `GPU placement/flow failed: ${String(error)}; recreate the WebGPU device and check its limits`,
    'biomes',
  );
}
