// Chunk stores (design: packages/voxel/DESIGN.md, `./stream`): where unloaded chunks are saved and found again.
// Records are encodeChunk bytes; VoxelStreamer (phase 9) joins this entry.
import { MargoError } from '@margoengine/math/errors';
import { VoxelChunk } from './chunk.js';
import { decodeChunk, encodeChunk } from './codec.js';
import { chunkKey } from './world.js';

/**
 * Where chunks are saved when they unload and looked up before they are generated again. Chunk coordinates are
 * cell >> 5. Implement it to save somewhere else (a server, OPFS); {@link IndexedDBChunkStore} and
 * {@link MemoryChunkStore} are the built-in ones.
 */
export interface ChunkStore {
  /** The chunk stored at chunk coordinates (cx, cy, cz), or undefined. Sees every put and delete made before it. */
  get(cx: number, cy: number, cz: number): Promise<VoxelChunk | undefined>;
  /**
   * Stores a copy of `chunk` as it is now (later edits are not saved); resolves once it is stored. Invalid
   * arguments throw at the call; a storage failure rejects this promise and the next flush, so a caller that
   * awaits flush may ignore it.
   */
  put(cx: number, cy: number, cz: number, chunk: VoxelChunk): Promise<void>;
  /** Removes the chunk stored at (cx, cy, cz); resolves once it is gone. Errors as for put. */
  delete(cx: number, cy: number, cz: number): Promise<void>;
  /** Resolves once every put and delete made before it is stored; rejects when one failed since the last flush. */
  flush(): Promise<void>;
}

type Key = [cx: number, cy: number, cz: number];
// Chunk coordinates are cell >> 5 of a 32-bit cell coordinate: 27-bit signed integers.
const key = (cx: number, cy: number, cz: number): Key => {
  if ([cx, cy, cz].every((c) => (c << 5) >> 5 === c)) return [cx, cy, cz];
  throw [cx, cy, cz].every((c) => typeof c === 'number')
    ? new RangeError(`Chunk (${cx}, ${cy}, ${cz}) is not three integers in -2^26..2^26-1; pass cell >> 5`)
    : new TypeError('Chunk coordinates must be numbers');
};
const chunkOf = (chunk: unknown): VoxelChunk => {
  if (chunk instanceof VoxelChunk) return chunk;
  throw new TypeError('ChunkStore.put expects a VoxelChunk');
};

/**
 * A {@link ChunkStore} in memory, holding uncompressed {@link encodeChunk} bytes: for tests, servers and sessions
 * that need not outlive the page.
 */
export class MemoryChunkStore implements ChunkStore {
  private readonly records = new Map<string, Promise<Uint8Array>>();
  /** @throws RangeError or TypeError (rejects) for invalid chunk coordinates. */
  async get(cx: number, cy: number, cz: number): Promise<VoxelChunk | undefined> {
    const bytes = this.records.get(chunkKey(...key(cx, cy, cz)));
    return bytes && decodeChunk(await bytes);
  }
  /** @throws TypeError when `chunk` is not a VoxelChunk; RangeError or TypeError for invalid chunk coordinates. */
  put(cx: number, cy: number, cz: number, chunk: VoxelChunk): Promise<void> {
    const at = chunkKey(...key(cx, cy, cz)),
      bytes = encodeChunk(chunkOf(chunk), { compress: false });
    this.records.set(at, bytes);
    return bytes.then(() => {});
  }
  /** @throws RangeError or TypeError for invalid chunk coordinates. */
  delete(cx: number, cy: number, cz: number): Promise<void> {
    this.records.delete(chunkKey(...key(cx, cy, cz)));
    return Promise.resolve();
  }
  /** Resolves at once: memory writes complete when put returns. */
  async flush(): Promise<void> {}
}

const STORE = 'chunks';
type Op = { key: Key; bytes: Promise<Uint8Array> | null };
const failed = (name: string, action: string, error: unknown): MargoError =>
  error instanceof MargoError
    ? error
    : new MargoError(
        'failed',
        `IndexedDBChunkStore "${name}" could not ${action} (${(error as Error | null)?.name ?? 'aborted'}); free storage or reopen the store`,
      );
const result = <T>(request: IDBRequest<T>, name: string, action: string): Promise<T> =>
  new Promise((ok, no) => {
    request.onsuccess = () => ok(request.result);
    request.onerror = () => no(failed(name, action, request.error));
  });
const commit = (t: IDBTransaction, name: string): Promise<void> =>
  new Promise((ok, no) => {
    t.oncomplete = () => ok();
    t.onerror = t.onabort = () => no(failed(name, 'write', t.error));
  });

/**
 * A {@link ChunkStore} in IndexedDB: database `name`, object store `'chunks'`, one deflated {@link encodeChunk}
 * record per chunk keyed `[cx, cy, cz]`. Puts and deletes made in one task are compressed, then written in one
 * transaction after the previous one, in call order; get sees writes that are not committed yet.
 */
export class IndexedDBChunkStore implements ChunkStore {
  /** The IndexedDB database name: one per world or save. */
  readonly name: string;
  private readonly db: Promise<IDBDatabase>;
  private readonly pending = new Map<string, Op>(); // queued or committing, by chunkKey
  private readonly writing = new Set<Promise<void>>();
  private queue: Op[] = [];
  private batch: Promise<void> | null = null;
  private last: Promise<unknown> = Promise.resolve();
  private error: MargoError | null = null; // the first failure since the last flush
  /**
   * Opens database `name` (default `'margo-voxel'`), creating it on first use.
   * @throws TypeError for a name that is not a non-empty string.
   * @throws MargoError `'unsupported'` when the runtime lacks IndexedDB or CompressionStream.
   */
  constructor(name = 'margo-voxel') {
    if (typeof name !== 'string' || !name)
      throw new TypeError('IndexedDBChunkStore name must be a non-empty string such as "world-1"');
    if (typeof indexedDB === 'undefined' || typeof CompressionStream !== 'function')
      throw new MargoError(
        'unsupported',
        'IndexedDBChunkStore needs IndexedDB and CompressionStream, which this runtime lacks; use MemoryChunkStore',
      );
    this.name = name;
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    this.db = result(request, name, 'open its database');
    this.db.then(
      (db) => {
        db.onversionchange = () => db.close(); // let another tab delete or upgrade it
      },
      () => {}, // reported by each call that needs the database
    );
  }
  /**
   * @throws RangeError or TypeError (rejects) for invalid chunk coordinates or a damaged record.
   * @throws MargoError `'failed'` (rejects) when IndexedDB fails.
   */
  async get(cx: number, cy: number, cz: number): Promise<VoxelChunk | undefined> {
    const at = key(cx, cy, cz),
      op = this.pending.get(chunkKey(...at));
    if (op) return op.bytes ? decodeChunk(await op.bytes) : undefined;
    let bytes: unknown;
    try {
      bytes = await result((await this.db).transaction(STORE).objectStore(STORE).get(at), this.name, 'read');
    } catch (error) {
      throw failed(this.name, 'read', error);
    }
    return bytes === undefined ? undefined : decodeChunk(bytes as Uint8Array);
  }
  /**
   * @throws TypeError when `chunk` is not a VoxelChunk, or as {@link IndexedDBChunkStore.delete}.
   */
  put(cx: number, cy: number, cz: number, chunk: VoxelChunk): Promise<void> {
    const at = key(cx, cy, cz);
    return this.write(at, encodeChunk(chunkOf(chunk)));
  }
  /**
   * @throws RangeError or TypeError for invalid chunk coordinates.
   * @throws MargoError `'failed'` (rejects) when IndexedDB fails to commit the batch.
   */
  delete(cx: number, cy: number, cz: number): Promise<void> {
    return this.write(key(cx, cy, cz), null);
  }
  /** @throws MargoError `'failed'` (rejects) when a write failed since the last flush (the error is then cleared). */
  async flush(): Promise<void> {
    await Promise.allSettled(this.writing);
    const error = this.error;
    this.error = null;
    if (error) throw error;
  }
  private write(at: Key, bytes: Promise<Uint8Array> | null): Promise<void> {
    const op: Op = { key: at, bytes };
    bytes?.catch(() => {}); // a failed encode fails its batch
    this.pending.set(chunkKey(...at), op);
    this.queue.push(op);
    if (this.batch) return this.batch;
    const previous = this.last,
      batch = new Promise<void>((ok) => setTimeout(ok, 0)).then(async () => {
        const ops = this.queue;
        this.queue = [];
        this.batch = null;
        try {
          await previous.catch(() => {});
          const values = await Promise.all(ops.map((o) => o.bytes)),
            t = (await this.db).transaction(STORE, 'readwrite'),
            store = t.objectStore(STORE);
          ops.forEach((o, i) => (o.bytes ? store.put(values[i], o.key) : store.delete(o.key)));
          await commit(t, this.name);
        } catch (error) {
          const e = failed(this.name, 'write', error);
          this.error ??= e;
          throw e;
        } finally {
          for (const o of ops) {
            const k = chunkKey(...o.key);
            if (this.pending.get(k) === o) this.pending.delete(k);
          }
        }
      });
    this.batch = this.last = batch;
    this.writing.add(batch);
    batch.then(
      () => this.writing.delete(batch),
      () => this.writing.delete(batch),
    );
    return batch;
  }
}
