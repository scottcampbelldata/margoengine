// @margoengine/voxel/light-worker: VoxelLighting's flood fill in a Web Worker. The worker keeps a copy of the world's
// blocks (chunk loads, unloads and edits are posted to it in order), runs the same VoxelLighting on its copy and posts
// back the light bytes and heightmaps of the chunks whose light changed; update() writes them into the world's chunks
// and marks those chunks dirty. The main thread only packs chunks and copies light bytes, so a big edit costs no frame.
import { MargoError } from '@margoengine/math/errors';
import type { BlockType } from './blocks.js';
import { type VoxelChunk, writeLight } from './chunk.js';
import { chunkKey, VoxelWorld } from './world.js';

/** Options of {@link VoxelLightWorker.attach}. */
export interface VoxelLightWorkerOptions {
  /**
   * The worker to run, for tests and bundlers that cannot follow `new URL(..., import.meta.url)`. Default the bundled
   * `dist/workers/light.js`.
   */
  worker?: Worker;
}

/** A batch for the worker, in the order things happened on the page. */
export interface LightJob {
  init?: { minY: number; maxY: number };
  /** Block types defined since the last batch (all of them in the first). */
  types?: readonly BlockType[];
  /** Chunk loads (packed blocks, light dropped) and unloads (`chunk` undefined), in order. */
  chunks: { cx: number; cy: number; cz: number; generation: number; chunk?: ReturnType<VoxelChunk['pack']> }[];
  /** Edits since the last batch: x, y, z, state per edit. */
  edits: Int32Array;
  /** Number of this batch. */
  batch: number;
}

/** The worker's answer to a batch: light of the chunks it changed. */
export interface LightReply {
  batch: number;
  /** Light of every chunk whose light, or one-cell shell, may have changed (remesh them). */
  chunks: { cx: number; cy: number; cz: number; generation: number; light: number | Uint8Array }[];
  /** Heightmaps of the columns of those chunks: cx, cz and 1,024 int16 heights. */
  columns: { cx: number; cz: number; heights: Int16Array }[];
}

const worlds = new WeakSet<VoxelWorld>();

/**
 * Sky and block light like `VoxelLighting` (`@margoengine/voxel/light`), computed in a Web Worker: the same levels, the
 * same rules, written into the same light bytes, so a renderer and mesher see no difference, but a roof removed or a
 * chunk loaded costs the page only the copies. Light arrives a frame or more after the change.
 */
export class VoxelLightWorker {
  readonly world: VoxelWorld;
  #worker: Worker;
  #off: (() => void)[] = [];
  #chunks: LightJob['chunks'] = [];
  #edits: number[] = [];
  #replies: LightReply[] = [];
  #generation = new Map<string, number>();
  #next = 0;
  #sent = 0;
  #types = 0;
  #done = 0;
  #error?: Error;
  #waiters: (() => void)[] = [];
  #disposed = false;

  /**
   * Starts the worker and gives it the chunks loaded now; later loads, unloads and edits follow.
   * @throws TypeError for a wrong world or options.
   * @throws MargoError `unsupported` without Web Workers, `attached` when the world already has one.
   */
  static attach(world: VoxelWorld, options: VoxelLightWorkerOptions = {}): VoxelLightWorker {
    return new VoxelLightWorker(world, options);
  }

  private constructor(world: VoxelWorld, options: VoxelLightWorkerOptions) {
    if (!(world instanceof VoxelWorld))
      throw new TypeError('VoxelLightWorker.attach expects a VoxelWorld; pass new VoxelWorld({blocks})');
    if (!options || typeof options !== 'object') throw new TypeError('VoxelLightWorker options must be an object');
    if (options.worker !== undefined && typeof options.worker?.postMessage !== 'function')
      throw new TypeError('VoxelLightWorker worker must be a Worker; leave it out for the bundled one');
    if (!options.worker && typeof Worker !== 'function')
      throw new MargoError(
        'unsupported',
        'VoxelLightWorker needs Web Workers; use VoxelLighting from @margoengine/voxel/light on this thread',
      );
    if (worlds.has(world))
      throw new MargoError(
        'attached',
        'VoxelWorld already has a VoxelLightWorker; dispose() it before attaching another',
      );
    worlds.add(world);
    this.world = world;
    this.#worker =
      options.worker ??
      new Worker(new URL(/* @vite-ignore */ './workers/light.js?no-inline', import.meta.url), {
        name: 'margoengine-light',
      });
    this.#worker.onmessage = ({ data }: MessageEvent) => {
      if (data?.error) this.#fail(Object.assign(new Error(data.error.message), { name: data.error.name }));
      else if (data?.result) {
        this.#replies.push(data.result as LightReply);
        this.#done = (data.result as LightReply).batch;
        if (this.#done === this.#sent) for (const resolve of this.#waiters.splice(0)) resolve();
      }
    };
    this.#worker.onerror = (event: ErrorEvent) => {
      event.preventDefault?.();
      this.#fail(new MargoError('failed', `VoxelLightWorker worker failed: ${event.message}; check the worker URL`));
    };
    // onChunk calls back at once for every loaded chunk: they go in the first batch, with the world's range.
    this.#off.push(
      world.onChunk((cx, cy, cz, chunk) => this.#load(cx, cy, cz, chunk)),
      world.onChange((x, y, z, state) => this.#edits.push(x, y, z, state)),
    );
    this.#post({ minY: world.minY, maxY: world.maxY });
  }

  #load(cx: number, cy: number, cz: number, chunk: VoxelChunk | undefined): void {
    const generation = ++this.#next,
      key = chunkKey(cx, cy, cz);
    if (chunk) this.#generation.set(key, generation);
    else this.#generation.delete(key);
    // Edits made before this load or unload go first, so the worker sees them in page order.
    if (this.#edits.length) this.#post();
    const packed = chunk?.pack();
    if (packed) packed.light = 0;
    this.#chunks.push({ cx, cy, cz, generation, chunk: packed });
  }

  #post(init?: LightJob['init']): void {
    const table = this.world.blocks.table;
    if (!init && !this.#chunks.length && !this.#edits.length && this.#types === table.length) return;
    const job: LightJob = { chunks: this.#chunks, edits: Int32Array.from(this.#edits), batch: ++this.#sent };
    if (init) job.init = init;
    if (this.#types !== table.length) job.types = table.slice(this.#types);
    this.#types = table.length;
    this.#chunks = [];
    this.#edits.length = 0;
    const transfer: Transferable[] = [job.edits.buffer];
    for (const { chunk } of job.chunks) if (chunk) transfer.push(chunk.palette.buffer, chunk.words.buffer);
    this.#worker.postMessage(job, transfer);
  }

  #fail(error: Error): void {
    this.#error ??= error;
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  /** True while the worker has changes it has not answered yet. */
  get busy(): boolean {
    return this.#done !== this.#sent || this.#edits.length > 0 || this.#chunks.length > 0;
  }

  /**
   * Sends the edits and chunk loads since the last call to the worker, and writes the light it has finished into the
   * world's chunks (a chunk unloaded or loaded again since is skipped), adding them to `world.dirty`. Call it once a
   * frame. Returns the chunks written.
   * @throws MargoError `disposed` after `dispose()`; the worker's error once it failed.
   */
  update(): number {
    if (this.#disposed) throw new MargoError('disposed', 'VoxelLightWorker is disposed; attach a new one');
    if (this.#error) throw this.#error;
    this.#post();
    let written = 0;
    for (const reply of this.#replies.splice(0)) {
      for (const { cx, cy, cz, generation, light } of reply.chunks) {
        const key = chunkKey(cx, cy, cz),
          chunk = this.world.getChunk(cx, cy, cz);
        if (!chunk || this.#generation.get(key) !== generation) continue;
        writeLight(chunk, light);
        this.world.dirty.add(key);
        written++;
      }
      for (const { cx, cz, heights } of reply.columns) this.world.heightmap(cx, cz)?.set(heights);
    }
    return written;
  }

  /**
   * Resolves once the worker has answered every change made so far (call {@link VoxelLightWorker.update} after it to
   * write the light), for loading screens and tests.
   * @throws MargoError `disposed` after `dispose()`.
   */
  async settled(signal?: AbortSignal): Promise<void> {
    if (this.#disposed) throw new MargoError('disposed', 'VoxelLightWorker is disposed; attach a new one');
    this.#post();
    signal?.throwIfAborted();
    if (this.#done !== this.#sent && !this.#error)
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal?.reason);
        signal?.addEventListener('abort', abort, { once: true });
        this.#waiters.push(() => {
          signal?.removeEventListener('abort', abort);
          resolve();
        });
      });
    if (this.#error) throw this.#error;
  }

  /** Stops the worker and following the world. Light already written stays. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const off of this.#off) off();
    this.#worker.terminate();
    worlds.delete(this.world);
    this.#fail(new MargoError('disposed', 'VoxelLightWorker is disposed; attach a new one'));
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
