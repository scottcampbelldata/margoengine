import { MargoError } from '@margoengine/math/errors';
import { resolveOptions, type BVHBuildOptions, type BVHData } from './build.js';
import { MeshBVH, sourceArrays, type GeometryLike, type TriangleSource } from './bvh.js';

/** Options for a complete build distributed over module workers. */
export interface ParallelBuildOptions extends BVHBuildOptions {
  /** Leaf workers, in addition to one coordinator. Default min(8, hardwareConcurrency - 1), at least 1. */
  workers?: number;
  /** Cancellation terminates the coordinator and its workers. Input buffers are never transferred. */
  signal?: AbortSignal;
  /** Hard limit for the whole build, including worker startup. Default 120000 milliseconds. */
  timeoutMs?: number;
}

/**
 * Builds one mesh across several workers, retaining the serial builder's topology and original face ids.
 * SharedArrayBuffer is used when available; otherwise worker inputs are cloned. Without Worker, builds locally
 * on the next microtask. Positions must remain unchanged until the promise settles; later edits support refit().
 */
export async function buildParallel(
  source: GeometryLike | TriangleSource,
  options: ParallelBuildOptions = {},
): Promise<MeshBVH> {
  const {
    workers = Math.max(1, Math.min(8, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1)),
    signal,
    timeoutMs = 120000,
    ...buildOptions
  } = options;
  resolveOptions(buildOptions);
  if (!Number.isInteger(workers) || workers < 1 || workers > 64)
    throw new RangeError('workers must be an integer in 1..64');
  if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs) || timeoutMs > 2147483647)
    throw new RangeError('timeoutMs must be finite and in 0..2147483647, excluding zero');
  signal?.throwIfAborted();
  if (typeof Worker === 'undefined') {
    await Promise.resolve();
    signal?.throwIfAborted();
    return MeshBVH.build(source, buildOptions);
  }
  const arrays = sourceArrays(source);
  return new Promise<MeshBVH>((resolve, reject) => {
    const coordinator = new Worker(new URL('./parallel.worker.js', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (error?: unknown, data?: BVHData): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      coordinator.terminate();
      if (error !== undefined) reject(error);
      else {
        try {
          resolve(new MeshBVH(data!, source));
        } catch (failure) {
          reject(failure);
        }
      }
    };
    const abort = (): void => finish(signal?.reason);
    const timer = setTimeout(
      () =>
        finish(
          new MargoError(
            'timeout',
            `Parallel BVH build exceeded ${timeoutMs} ms; reduce the input or increase timeoutMs; see https://margoengine.com/errors#timeout`,
          ),
        ),
      timeoutMs,
    );
    coordinator.onmessage = ({ data }): void => {
      if (data.error)
        finish(
          new MargoError(
            'failed',
            `${data.error}; correct the source or worker configuration; see https://margoengine.com/errors#failed`,
          ),
        );
      else finish(undefined, data);
    };
    coordinator.onerror = (event): void => {
      event.preventDefault?.();
      finish(
        new MargoError(
          'failed',
          `${event.message || 'Parallel BVH worker failed'}; check module worker loading; see https://margoengine.com/errors#failed`,
        ),
      );
    };
    coordinator.onmessageerror = (): void =>
      finish(
        new MargoError(
          'failed',
          'Parallel BVH result could not be deserialized; check module worker loading; see https://margoengine.com/errors#failed',
        ),
      );
    signal?.addEventListener('abort', abort, { once: true });
    try {
      coordinator.postMessage({ ...arrays, options: buildOptions, workers });
    } catch (error) {
      finish(error);
    }
  });
}
