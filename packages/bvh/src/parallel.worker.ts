import { resolveOptions, type BVHBuildOptions, type BVHData } from './build.js';
import type { BVHPositions } from './bvh.js';
import { planBuild, mergeBuild } from './parallel-build.js';
import { MargoError } from '@margoengine/math/errors';

const scope = globalThis as unknown as {
  onmessage: (
    event: MessageEvent<{
      positions: BVHPositions;
      stride: number;
      indices: Uint32Array | null;
      options: BVHBuildOptions;
      workers: number;
    }>,
  ) => void;
  postMessage(message: unknown, transfer: Transferable[]): void;
};

scope.onmessage = async ({ data }) => {
  const pool: Worker[] = [];
  try {
    const { positions, stride, indices, workers, options } = data;
    const resolved = resolveOptions(options);
    const plan = planBuild(positions, stride, indices, resolved, workers);
    let shared = positions;
    if (plan.parts.length && typeof SharedArrayBuffer === 'function') {
      const buffer = new SharedArrayBuffer(positions.byteLength);
      shared = positions instanceof Float64Array ? new Float64Array(buffer) : new Float32Array(buffer);
      shared.set(positions);
    }
    const results: BVHData[] = new Array(plan.parts.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(workers, plan.parts.length) }, async () => {
        const worker = new Worker(new URL('./parallel-leaf.worker.js', import.meta.url), { type: 'module' });
        pool.push(worker);
        let first = true;
        while (next < plan.parts.length) {
          const id = next++,
            part = plan.parts[id];
          const input = plan.top.index.slice(part.offset * 3, (part.offset + part.count) * 3);
          results[id] = await new Promise<BVHData>((resolve, reject) => {
            worker.onmessage = ({ data }): void =>
              data.error ? reject(new MargoError('failed', `${data.error}; check input.`)) : resolve(data);
            worker.onerror = (event): void => {
              event.preventDefault?.();
              reject(new MargoError('failed', `${event.message}; check worker loading.`));
            };
            worker.onmessageerror = (): void =>
              reject(new MargoError('failed', 'BVH leaf message could not be deserialized; check worker loading.'));
            worker.postMessage(
              {
                positions: first ? shared : undefined,
                stride,
                indices: input,
                options: { ...resolved, maxDepth: resolved.maxDepth - part.depth },
              },
              [input.buffer],
            );
          });
          first = false;
        }
      }),
    );
    const result = mergeBuild(plan, results);
    scope.postMessage(result, [result.nodes, result.index.buffer, result.triangles.buffer]);
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) }, []);
  } finally {
    for (const worker of pool) worker.terminate();
  }
};
