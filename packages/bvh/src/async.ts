import {resolveOptions, type BVHBuildOptions, type BVHData} from './build.js';
import {MeshBVH, sourceArrays, type GeometryLike, type TriangleSource} from './bvh.js';

export interface AsyncBuildOptions extends BVHBuildOptions {
  /**
   * Move raw `positions` and `indices` buffers to the worker instead of copying them. They come back with the
   * result and the returned BVH reads the returned arrays; the caller's own views are detached meanwhile.
   * Ignored for a Geometry, whose vertices stay with the engine. Default false.
   */
  transfer?: boolean;
  signal?: AbortSignal;
}

interface Pending {resolve(bvh: MeshBVH): void; reject(error: unknown): void; source: GeometryLike | TriangleSource; transfer: boolean}
interface Reply extends Partial<BVHData> {id: number; error?: string; positions?: Float32Array | null; indices?: Uint32Array | null}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function failAll(error: unknown): void {
  for (const job of pending.values()) job.reject(error);
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(new URL('./bvh.worker.js', import.meta.url), {type: 'module'});
  created.onmessage = ({data}: MessageEvent<Reply>) => {
    const job = pending.get(data.id);
    if (!job) return;
    pending.delete(data.id);
    if (data.error) { job.reject(new Error(data.error)); return; }
    try {
      let source = job.source;
      if (job.transfer && data.positions) source = {...(source as TriangleSource), positions: data.positions, indices: data.indices ?? null};
      job.resolve(new MeshBVH({nodes: data.nodes!, index: data.index!, triangles: data.triangles!}, source));
    } catch (error) { job.reject(error); }
  };
  created.onerror = event => {
    event.preventDefault?.();
    failAll(new Error(`BVH worker failed: ${event.message || 'unknown error'}`));
    created.terminate();
    if (worker === created) worker = null;
  };
  created.onmessageerror = () => failAll(new Error('BVH worker message could not be deserialized'));
  return worker = created;
}

/**
 * Builds the BVH in a module worker and transfers the node, index and triangle buffers back without copying.
 * Without `Worker` (Node, SSR) it builds synchronously on the next microtask instead.
 */
export function buildAsync(source: GeometryLike | TriangleSource, options: AsyncBuildOptions = {}): Promise<MeshBVH> {
  const {transfer = false, signal, ...buildOptions} = options;
  try { resolveOptions(buildOptions); } catch (error) { return Promise.reject(error); }
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
  if (typeof Worker === 'undefined') return Promise.resolve().then(() => {
    if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
    return MeshBVH.build(source, buildOptions);
  });
  let arrays: ReturnType<typeof sourceArrays>;
  try { arrays = sourceArrays(source); } catch (error) { return Promise.reject(error); }
  const isGeometry = arrays.stride === 6 && (source as GeometryLike).vertices === arrays.positions;
  const move = transfer && !isGeometry;
  if (move && (source as TriangleSource).normals && ((source as TriangleSource).normals as Float32Array).buffer === arrays.positions.buffer)
    return Promise.reject(new TypeError('transfer cannot move positions that share a buffer with normals'));
  return new Promise<MeshBVH>((resolve, reject) => {
    const id = nextId++;
    const onAbort = (): void => { if (pending.delete(id)) reject(signal!.reason ?? new Error('Aborted')); };
    pending.set(id, {
      resolve: bvh => { signal?.removeEventListener('abort', onAbort); resolve(bvh); },
      reject: error => { signal?.removeEventListener('abort', onAbort); reject(error); },
      source: move ? {...(source as TriangleSource), positions: arrays.positions, indices: arrays.indices} : source, transfer: move,
    });
    signal?.addEventListener('abort', onAbort, {once: true});
    const list: Transferable[] = [];
    if (move) {
      if (!isShared(arrays.positions.buffer)) list.push(arrays.positions.buffer as ArrayBuffer);
      if (arrays.indices && arrays.indices.buffer !== arrays.positions.buffer && !isShared(arrays.indices.buffer)) list.push(arrays.indices.buffer as ArrayBuffer);
    }
    try {
      getWorker().postMessage({id, positions: arrays.positions, stride: arrays.stride, indices: arrays.indices, options: buildOptions, returnSource: move}, list);
    } catch (error) { pending.get(id)?.reject(error); pending.delete(id); }
  });
}

/** Terminates the shared build worker. Pending builds reject; the next `buildAsync` starts a new worker. */
export function terminateBVHWorker(): void {
  if (!worker) return;
  worker.terminate(); worker = null;
  failAll(new Error('BVH worker terminated'));
}

const isShared = (buffer: ArrayBufferLike): boolean => typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer;
