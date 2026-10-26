// One compute dispatch read back to the CPU as an owned copy, with abort, timeout and device-loss settlement.
import { MargoError } from '@margoengine/math/errors';
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { ComputePass, StorageBuffer, observeDeviceLoss, type ComputeBody, type StorageType } from './compute.js';
import { scalarOf, type Node } from './node.js';
declare const GPUBufferUsage: { MAP_READ: number; COPY_DST: number };
declare const GPUMapMode: { READ: number };
/** The typed array holding a `StorageType`'s elements: Float32Array for f32 types, Int32Array for i32, Uint32Array for u32. */
export type StorageArray<T extends StorageType = StorageType> = T extends 'f32' | 'vec2f' | 'vec4f'
  ? Float32Array<ArrayBuffer>
  : T extends 'i32' | 'vec2i' | 'vec4i'
    ? Int32Array<ArrayBuffer>
    : Uint32Array<ArrayBuffer>;
/** Options of {@link computeReadback}. */
export interface ComputeReadbackOptions {
  /** Invocations per workgroup, integer 1..256. Default 64. */
  workgroupSize?: number;
  /** Label of the job's GPU objects and errors. Default `'shader:readback:<n>'` (n counts jobs). */
  name?: string;
  /** Cancels the job: the promise rejects with `signal.reason` and the job's GPU objects are released. */
  signal?: AbortSignal;
  /** Milliseconds before the job rejects with MargoError `'failed'`, more than 0. Default 30,000; `Infinity` waits. */
  timeout?: number;
}
/** What {@link computeReadback} resolves with. */
export interface ComputeReadback<T extends StorageType = StorageType> {
  /** The output buffer's elements after the dispatch: a copy the caller owns, not `output.data` and not GPU memory. */
  readonly data: StorageArray<T>;
  /** Element type of `output`. */
  readonly type: T;
  /** Elements read, `output.count`. */
  readonly count: number;
}
let jobs = 0;
const isDevice = (target: GPUDevice | EngineKernel): target is GPUDevice =>
  typeof (target as GPUDevice).createCommandEncoder === 'function';
/**
 * Runs `body` once for `count` invocations (one dispatch of one submitted command buffer, outside any frame) and
 * resolves with a copy of `output` read back from the GPU. `target` is a GPUDevice or an engine (its current device).
 * Storage the body reads or writes, `output` included, is uploaded first if its `data` changed; it stays the
 * caller's to dispose. Frame values read 1 x 1 for the resolution and 0 for deltaTime.
 *
 * Settlement, exactly once:
 * - resolves with the copy once the GPU finished;
 * - rejects with `signal.reason` when `signal` aborts first (before the call: without touching the GPU);
 * - rejects with MargoError `'disposed'` when the engine was disposed during the job, `'failed'` when the device was
 *   lost (its reason is in the message), the WGSL or a GPU call failed validation or memory, or `timeout` elapsed,
 *   and `'unsupported'` for an engine without WebGPU; RangeError for invalid counts or a too-large `output`.
 *
 * Resources: whatever the outcome, the job's readback buffer and uniform buffer are destroyed and its listeners and
 * timer removed when it settles; a pending map is cancelled by that destroy. Nothing of the job outlives its promise.
 */
export async function computeReadback<T extends StorageType>(
  target: GPUDevice | EngineKernel,
  count: number,
  body: (index: Node<'u32'>) => ComputeBody,
  output: StorageBuffer<T>,
  options: ComputeReadbackOptions = {},
): Promise<ComputeReadback<T>> {
  const { signal, timeout = 30_000, workgroupSize, name = 'shader:readback:' + jobs++ } = options;
  signal?.throwIfAborted();
  if (!(output instanceof StorageBuffer)) throw new TypeError('computeReadback output must be a StorageBuffer');
  if (!(timeout > 0)) throw new RangeError('computeReadback timeout must be more than 0 milliseconds');
  const runtime = isDevice(target) ? undefined : engineRuntime(target);
  if (runtime?.disposed)
    throw new MargoError('disposed', 'Engine is disposed; read back compute results with a live engine');
  const device = runtime ? runtime.gpu : (target as GPUDevice);
  if (!device)
    throw new MargoError('unsupported', 'computeReadback requires WebGPU; the engine runs on the WebGL2 fallback');
  const pass = new ComputePass(count, body, { workgroupSize, name }),
    bytes = output.data.byteLength;
  if (bytes > device.limits.maxBufferSize)
    throw new RangeError(
      `computeReadback output of ${bytes} bytes exceeds the device's ${device.limits.maxBufferSize}; read back a smaller output.`,
    );
  return new Promise<ComputeReadback<T>>((resolve, reject) => {
    let readback: GPUBuffer | undefined,
      settled = false;
    const release = () => {
      signal?.removeEventListener('abort', abort);
      stopLoss();
      clearTimeout(timer);
      readback?.destroy();
      pass.program.release(device);
    };
    const settle = (error: unknown, result?: ComputeReadback<T>) => {
      if (settled) return;
      settled = true;
      try {
        release();
      } catch {
        // A lost device may refuse destroy(); the job is over either way.
      }
      if (result) resolve(result);
      else reject(error);
    };
    const abort = () => settle(signal?.reason ?? new DOMException(`Compute readback "${name}" aborted`, 'AbortError'));
    const lost = (info: GPUDeviceLostInfo) =>
      settle(
        runtime?.disposed
          ? new MargoError('disposed', `Engine was disposed during compute readback "${name}"; nothing was read back`)
          : new MargoError(
              'failed',
              `GPU device was lost (${info.reason}: ${info.message}) during compute readback "${name}"; run it again on a live device`,
            ),
      );
    // A GPU promise that rejects because the device went away settles as that loss: give device.lost a moment first.
    const failed = (error: unknown) => {
      let pause: ReturnType<typeof setTimeout> | undefined;
      void Promise.race([device.lost, new Promise((wait) => (pause = setTimeout(wait, 50)))]).then(() => {
        clearTimeout(pause);
        settle(
          new MargoError(
            'failed',
            `Compute readback "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      });
    };
    signal?.addEventListener('abort', abort, { once: true });
    const stopLoss = observeDeviceLoss(device, lost),
      timer =
        timeout === Infinity
          ? undefined
          : setTimeout(
              () =>
                settle(
                  new MargoError(
                    'failed',
                    `Compute readback "${name}" did not finish within ${timeout} ms; reduce the work or raise the timeout`,
                  ),
                ),
              timeout,
            );
    void (async () => {
      device.pushErrorScope('out-of-memory');
      device.pushErrorScope('validation');
      let thrown: unknown;
      try {
        const encoder = device.createCommandEncoder({ label: name });
        pass.encode(device, encoder, { width: 1, height: 1, delta: 0 });
        readback = device.createBuffer({
          label: name + ':readback',
          size: bytes,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        encoder.copyBufferToBuffer(output.buffer(device), 0, readback, 0, bytes);
        device.queue.submit([encoder.finish()]);
      } catch (error) {
        thrown = error;
      }
      // Pop both scopes even when recording threw, so the device's scope stack stays balanced.
      const scopes = [device.popErrorScope(), device.popErrorScope()];
      if (thrown !== undefined) {
        void Promise.allSettled(scopes);
        return settle(thrown);
      }
      const problem = (await Promise.all(scopes)).find(Boolean);
      if (settled) return;
      if (problem)
        return settle(new MargoError('failed', `Compute readback "${name}" failed on the GPU: ${problem.message}`));
      const buffer = readback as GPUBuffer;
      await buffer.mapAsync(GPUMapMode.READ);
      if (settled) return;
      const copy = buffer.getMappedRange().slice(0);
      buffer.unmap();
      const Kind = { f32: Float32Array, i32: Int32Array, u32: Uint32Array }[scalarOf(output.type) as 'f32'];
      settle(undefined, { data: new Kind(copy) as StorageArray<T>, type: output.type, count: output.count });
    })().catch((error) => {
      if (!settled) failed(error);
    });
  });
}
