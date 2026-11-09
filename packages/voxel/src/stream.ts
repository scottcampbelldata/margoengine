// Chunk stores and the streamer (design: packages/voxel/DESIGN.md, `./stream`): where unloaded chunks are saved and
// found again (records are encodeChunk bytes), and VoxelStreamer, which loads and unloads chunks around viewers.
import type { EngineKernel } from '@margoengine/core';
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { JobPool } from '../../shared/worker-pool.js';
import { type PackedChunk, VoxelChunk } from './chunk.js';
import { decodeChunk, encodeChunk } from './codec.js';
import { type NoiseTerrainOptions, noiseTerrain } from './generate.js';
import { chunkKey, VoxelWorld } from './world.js';

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

/** Options of {@link VoxelStreamer}. */
export interface VoxelStreamerOptions {
  /** The world chunks are added to and removed from. One streamer per world. */
  world: VoxelWorld;
  /**
   * Where chunks missing from the store come from: {@link NoiseTerrainOptions} for the built-in terrain (run in
   * classic workers, dist/workers/terrain.js), or the URL of your own module worker that calls
   * `serveVoxelGenerator` from `@margoengine/voxel/generate`. Default none: such chunks load as air.
   */
  generator?: NoiseTerrainOptions | URL | string;
  /** Where edited chunks are saved when they unload, and looked for before generating. Default a MemoryChunkStore. */
  store?: ChunkStore;
  /** Load radius in chunks around each viewer, in x and z (a circle), an integer in 0..64. Default 8 (256 blocks). */
  distance?: number;
  /** Load radius in chunks above and below each viewer, an integer in 0..64. Default 4. */
  verticalDistance?: number;
  /** Generator workers, started as jobs arrive. Default a quarter of the logical cores, 1 to 3. */
  workers?: number;
  /** Bytes of loaded chunk data ({@link VoxelChunk.byteLength}) to keep to. Default 128 MiB. */
  memoryBudget?: number;
  /** Most chunks added to the world per {@link VoxelStreamer.update}: an integer >= 1 or Infinity. Default 8. */
  chunksPerFrame?: number;
  /**
   * Main-thread milliseconds per {@link VoxelStreamer.update} for adding finished chunks (unpacking each, adding it,
   * and the world's onChunk listeners): no chunk is started once it is spent, but one always joins, so streaming
   * never stalls. A number >= 0 (0: one chunk per update) or Infinity. Default 0.5.
   */
  frameBudget?: number;
}

// A chunk position in a viewer's load range; `d` is its squared distance in chunks to the nearest viewer's chunk.
interface Spot {
  key: string;
  cx: number;
  cy: number;
  cz: number;
  d: number;
}
// A chunk in the world (`used`: the last ring it was in) or on its way; `edited` ones are saved when they unload.
interface Held {
  cx: number;
  cy: number;
  cz: number;
  chunk: VoxelChunk;
  edited: boolean;
  used: number;
}
// A finished load waiting to join the world: a generated chunk stays packed until then, so its unpack counts against
// chunksPerFrame and frameBudget.
type Ready = Omit<Held, 'chunk'> & { chunk: VoxelChunk | PackedChunk };
// A generator's reply: the packed chunk, with its column's ceiling when the generator gave one (serveVoxelGenerator).
type Generated = PackedChunk & { ceiling?: number };

const streamed = new WeakSet<VoxelWorld>();
let plugins = 0;
const isChunk = (c: number): boolean => (c << 5) >> 5 === c;
// An integer in min..max (max itself may be Infinity).
const whole = (name: string, value: unknown, min: number, max: number): number => {
  if (typeof value !== 'number') throw new TypeError(`VoxelStreamer ${name} must be a number`);
  if (!(value === max || (Number.isInteger(value) && value >= min && value <= max)))
    throw new RangeError(`VoxelStreamer ${name} is ${value}; pass an integer in ${min}..${max}`);
  return value;
};
const milliseconds = (value: unknown): number => {
  if (typeof value !== 'number') throw new TypeError('VoxelStreamer frameBudget must be a number of milliseconds');
  if (!(value >= 0)) throw new RangeError(`VoxelStreamer frameBudget is ${value}; pass milliseconds >= 0 or Infinity`);
  return value;
};
const bytes = (value: unknown): number => {
  if (typeof value !== 'number') throw new TypeError('VoxelStreamer memoryBudget must be a number of bytes');
  if (!(value > 0)) throw new RangeError(`VoxelStreamer memoryBudget is ${value}; pass bytes > 0 or Infinity`);
  return value;
};
const report = (error: unknown): void => {
  if (typeof reportError === 'function') reportError(error);
  else console.error(error);
};

/**
 * Loads and unloads the chunks of a {@link VoxelWorld} around its viewers: the engine camera (with
 * {@link VoxelStreamer.attach}) and the positions in {@link VoxelStreamer.viewers}. A chunk loads when it is within
 * `distance` chunks of a viewer's chunk in x and z and `verticalDistance` in y, and unloads once it is more than one
 * chunk past that for every viewer (the margin keeps chunks at the edge from loading and unloading over and over).
 * Loads run closest first, the store first and then the generator; finished chunks join the world closest first, per
 * update at most `chunksPerFrame` and no more once `frameBudget` milliseconds are spent (at least one). Lighting and
 * meshing follow through the world's onChunk and dirty set. A chunk that was edited (`world.onChange`), or that
 * someone else added, is saved to the store when it unloads; one generated or read from the store and not edited is
 * dropped. To fit `memoryBudget` it unloads the least recently used chunks outside the load range. Each finished
 * chunk waits until its actual byteLength fits (a budget smaller than the load range loads the closest chunks only).
 *
 * ```ts
 * const store = new IndexedDBChunkStore('world-1');
 * const streamer = VoxelStreamer.attach(engine, { world, generator: { seed: 7 }, store });
 * streamer.viewers.push(otherPlayer.position); // more positions (blocks) to load around
 * addEventListener('pagehide', () => streamer.save()); // edits of loaded chunks too
 * ```
 */
export class VoxelStreamer {
  /** The streamed world. */
  readonly world: VoxelWorld;
  /** Where edited chunks go when they unload. */
  readonly store: ChunkStore;
  /** Number of generator workers (started only with a generator). */
  readonly workers: number;
  /** Positions (in blocks) to load around besides the engine camera; read each update. */
  viewers: Vec3[] = [];
  /**
   * Receives failures: a chunk that could not be read or generated (tried again after it leaves the load range and
   * comes back) and a save that failed on unload (the chunk is kept, loads find it, and {@link VoxelStreamer.save}
   * tries again). Default the engine's onError with attach, else reportError or console.error.
   */
  onError: (error: unknown) => void = report;
  #distance: number;
  #vertical: number;
  #budget: number;
  #perFrame: number;
  #frameBudget: number;
  #pool: JobPool | undefined;
  #terrain: NoiseTerrainOptions | undefined;
  #camera: { readonly position: Vec3 } | undefined;
  #engine: EngineKernel | undefined;
  #plugin = '';
  #view = '\0'; // viewer chunks of the current ring
  #centres: number[] = [];
  #ring = new Map<string, Spot>();
  #order: Spot[] = [];
  #next = 0; // #order before it is loaded, loading, ready or failed (rewound when a chunk unloads)
  #tick = 0;
  #full = false;
  #room = 0; // bytes left under memoryBudget at the last update
  #mean = 0; // mean bytes of a loaded chunk at the last update (0 before any)
  #loaded = new Map<string, Held>();
  #loading = new Map<string, AbortController>();
  #ready = new Map<string, Ready>();
  #failed = new Map<string, { cx: number; cy: number; cz: number }>();
  #unsaved = new Map<string, Held>(); // edited chunks out of the world whose save has not succeeded yet
  #ceilings = new Map<string, number>(); // by column "cx,cz": no generated chunk of it has a block above this cell y
  #last: Held | undefined; // the chunk of the last edit
  #lx = Number.NaN;
  #ly = 0;
  #lz = 0;
  #offChunk: () => void;
  #offChange: () => void;
  #disposed = false;
  #closing: Promise<void> = Promise.resolve();

  /**
   * A streamer the engine drives: each frame runs {@link VoxelStreamer.update} with the camera as a viewer, failures go
   * to `engine.onError`, and disposing the engine disposes the streamer.
   * @throws as the constructor.
   */
  static attach(engine: EngineKernel, options: VoxelStreamerOptions): VoxelStreamer {
    const streamer = new VoxelStreamer(options),
      name = `voxel-streamer-${++plugins}`;
    streamer.#camera = engine.camera;
    streamer.#engine = engine;
    streamer.#plugin = name;
    streamer.onError = (error) => engine.onError(error);
    try {
      engine.use({ name, setup() {}, onPreUpdate: () => streamer.update(), dispose: () => void streamer.dispose() });
    } catch (error) {
      void streamer.dispose();
      throw error;
    }
    return streamer;
  }
  /**
   * A streamer you drive: call {@link VoxelStreamer.update} once a frame. It adopts the chunks already loaded as
   * edited (saved when they unload). Built-in terrain options and their block names are checked here.
   * @throws TypeError when `world` is not a VoxelWorld, `store` is not a ChunkStore, `generator` is neither terrain
   * options nor a URL, or a number option is not a number; as `noiseTerrain` for wrong terrain options.
   * @throws RangeError for `distance` or `verticalDistance` not an integer in 0..64, `workers` not an integer >= 1,
   * `chunksPerFrame` not an integer >= 1 or Infinity, `frameBudget` not >= 0, `memoryBudget` not > 0, or a terrain
   * option out of range or block name the world's types lack.
   * @throws MargoError `'attached'` when another VoxelStreamer streams `world`; `'unsupported'` for a generator in a
   * context without Web Workers.
   */
  constructor(options: VoxelStreamerOptions) {
    if (!(options?.world instanceof VoxelWorld))
      throw new TypeError('VoxelStreamer needs {world}: pass {world: new VoxelWorld({blocks})}');
    const { world, generator, store = new MemoryChunkStore() } = options;
    if (typeof store?.get !== 'function' || typeof store.put !== 'function' || typeof store.flush !== 'function')
      throw new TypeError('VoxelStreamer store must be a ChunkStore (get, put, delete, flush)');
    this.world = world;
    this.store = store;
    this.#distance = whole('distance', options.distance ?? 8, 0, 64);
    this.#vertical = whole('verticalDistance', options.verticalDistance ?? 4, 0, 64);
    this.#perFrame = whole('chunksPerFrame', options.chunksPerFrame ?? 8, 1, Infinity);
    this.#frameBudget = milliseconds(options.frameBudget ?? 0.5);
    this.#budget = bytes(options.memoryBudget ?? 128 * 1024 * 1024);
    const cores = globalThis.navigator?.hardwareConcurrency || 4;
    this.workers = whole('workers', options.workers ?? Math.max(1, Math.min(3, cores >> 2)), 1, 64);
    const url = typeof generator === 'string' || generator instanceof URL;
    if (generator !== undefined && !url) {
      if (!generator || typeof generator !== 'object')
        throw new TypeError('VoxelStreamer generator must be NoiseTerrainOptions or the URL of a module worker');
      this.#terrain = structuredClone(generator);
      // A chunk far above the ground: checks the options and block names here, where the error reaches the caller.
      noiseTerrain(this.#terrain)(new VoxelChunk(), 0, 1 << 20, 0, { blocks: world.blocks.table });
    }
    if (generator !== undefined && typeof Worker !== 'function')
      throw new MargoError('unsupported', 'VoxelStreamer generators run in Web Workers, which this context lacks');
    if (streamed.has(world))
      throw new MargoError('attached', 'VoxelWorld already has a VoxelStreamer; dispose() it before creating another');
    streamed.add(world);
    if (generator !== undefined)
      this.#pool = new JobPool(
        () =>
          url
            ? new Worker(generator, { type: 'module', name: 'margoengine-generator' })
            : new Worker(new URL(/* @vite-ignore */ './workers/terrain.js?no-inline', import.meta.url), {
                name: 'margoengine-terrain',
              }),
        this.workers,
      );
    this.#offChunk = world.onChunk((cx, cy, cz, chunk) => {
      const key = chunkKey(cx, cy, cz);
      this.#last = undefined;
      if (!chunk) {
        this.#loaded.delete(key);
        this.#next = 0;
      } else if (!this.#loaded.has(key)) this.#loaded.set(key, { cx, cy, cz, chunk, edited: true, used: this.#tick });
    });
    this.#offChange = world.onChange((x, y, z) => {
      const cx = x >> 5,
        cy = y >> 5,
        cz = z >> 5;
      if (!this.#last || cx !== this.#lx || cy !== this.#ly || cz !== this.#lz) {
        this.#lx = cx;
        this.#ly = cy;
        this.#lz = cz;
        this.#last = this.#loaded.get(chunkKey(cx, cy, cz));
      }
      if (this.#last) this.#last.edited = true;
    });
  }
  /** Load radius in chunks in x and z, an integer in 0..64; a change applies at the next update. */
  get distance(): number {
    return this.#distance;
  }
  set distance(value: number) {
    this.#distance = whole('distance', value, 0, 64);
    this.#view = '\0';
  }
  /** Load radius in chunks in y, an integer in 0..64; a change applies at the next update. */
  get verticalDistance(): number {
    return this.#vertical;
  }
  set verticalDistance(value: number) {
    this.#vertical = whole('verticalDistance', value, 0, 64);
    this.#view = '\0';
  }
  /** Most chunks added per update: an integer >= 1, or Infinity (with `frameBudget` Infinity behind a loading screen). */
  get chunksPerFrame(): number {
    return this.#perFrame;
  }
  set chunksPerFrame(value: number) {
    this.#perFrame = whole('chunksPerFrame', value, 1, Infinity);
  }
  /**
   * Main-thread milliseconds per update for adding finished chunks, >= 0 or Infinity: once spent, no more join that
   * update (one always does). Applies from the next update.
   */
  get frameBudget(): number {
    return this.#frameBudget;
  }
  set frameBudget(value: number) {
    this.#frameBudget = milliseconds(value);
  }
  /** Bytes of loaded chunk data to keep to, > 0 (Infinity allowed). */
  get memoryBudget(): number {
    return this.#budget;
  }
  set memoryBudget(value: number) {
    this.#budget = bytes(value);
  }
  /** Chunks in the load range of the last update that are not loaded yet, failed ones excluded: 0 when it is full. */
  get pending(): number {
    let n = 0;
    for (const key of this.#ring.keys()) if (!this.#loaded.has(key) && !this.#failed.has(key)) n++;
    return n;
  }
  /**
   * Unloads what left the range, adds finished chunks (up to `chunksPerFrame`, within `frameBudget`), unloads to the
   * memory budget and starts the next loads, closest first. Call it once a frame (attach does).
   * @throws TypeError or RangeError for a viewer that is not three finite numbers.
   * @throws MargoError `'disposed'` after {@link VoxelStreamer.dispose}.
   */
  update(): void {
    if (this.#disposed) throw new MargoError('disposed', 'VoxelStreamer is disposed; create a new VoxelStreamer');
    const centres: number[] = [];
    for (const p of this.#camera ? [this.#camera.position, ...this.viewers] : this.viewers) {
      if (typeof p?.[0] !== 'number' || typeof p[1] !== 'number' || typeof p[2] !== 'number')
        throw new TypeError('VoxelStreamer viewers must be [x, y, z] positions in blocks');
      if (!Number.isFinite(p[0] + p[1] + p[2]))
        throw new RangeError(`VoxelStreamer viewer [${p[0]}, ${p[1]}, ${p[2]}] is not finite; pass finite positions`);
      centres.push(Math.floor(p[0] / 32), Math.floor(p[1] / 32), Math.floor(p[2] / 32));
    }
    const view = centres.join();
    if (view !== this.#view) {
      this.#view = view;
      this.#centres = centres;
      this.#move();
    }
    this.#add();
    this.#evict();
    this.#start();
  }
  /**
   * Saves every edited chunk (loaded, or unloaded with a failed save) to the store and flushes it; unloads save by
   * themselves. Call it when the page hides.
   * @throws MargoError `'disposed'` (rejects) after {@link VoxelStreamer.dispose}, which saved already.
   * @throws (rejects) the store's error when a save failed; those chunks stay edited for the next save.
   */
  save(): Promise<void> {
    if (this.#disposed)
      return Promise.reject(new MargoError('disposed', 'VoxelStreamer is disposed; its dispose() saved already'));
    return this.#save();
  }
  /**
   * Stops streaming: cancels pending loads, stops the workers, then saves the edited chunks and flushes the store (the
   * returned promise settles as {@link VoxelStreamer.save}'s). Loaded chunks stay in the world.
   */
  dispose(): Promise<void> {
    if (this.#disposed) return this.#closing;
    this.#disposed = true;
    this.#offChunk();
    this.#offChange();
    streamed.delete(this.world);
    for (const job of this.#loading.values()) job.abort();
    this.#loading.clear();
    this.#ready.clear();
    this.#pool?.dispose();
    this.#closing = this.#save();
    this.#engine?.removePlugin(this.#plugin);
    return this.#closing;
  }
  [Symbol.dispose](): void {
    void this.dispose();
  }

  // Within one chunk past the load range of some viewer.
  #keeps(cx: number, cy: number, cz: number): boolean {
    const d = this.#distance + 1,
      v = this.#vertical + 1,
      c = this.#centres;
    for (let i = 0; i < c.length; i += 3) {
      const dx = cx - c[i],
        dz = cz - c[i + 2];
      if (dx * dx + dz * dz <= d * d && Math.abs(cy - c[i + 1]) <= v) return true;
    }
    return false;
  }
  // A viewer changed chunk: rebuild the load ring, then drop what is past the unload range.
  #move(): void {
    const d = this.#distance,
      v = this.#vertical,
      c = this.#centres,
      { minY, maxY } = this.world,
      ring = new Map<string, Spot>();
    for (let i = 0; i < c.length; i += 3)
      for (let dx = -d; dx <= d; dx++)
        for (let dz = -d; dz <= d; dz++) {
          const cx = c[i] + dx,
            cz = c[i + 2] + dz;
          if (dx * dx + dz * dz > d * d || !isChunk(cx) || !isChunk(cz)) continue;
          for (let dy = -v; dy <= v; dy++) {
            const cy = c[i + 1] + dy;
            if (cy * 32 > maxY || cy * 32 + 31 < minY) continue;
            const key = chunkKey(cx, cy, cz),
              distance = dx * dx + dy * dy + dz * dz,
              spot = ring.get(key);
            if (!spot) ring.set(key, { key, cx, cy, cz, d: distance });
            else if (distance < spot.d) spot.d = distance;
          }
        }
    this.#ring = ring;
    this.#order = [...ring.values()].sort((a, b) => a.d - b.d);
    this.#next = 0;
    const tick = ++this.#tick;
    for (const [key, held] of this.#loaded)
      if (ring.has(key)) held.used = tick;
      else if (!this.#keeps(held.cx, held.cy, held.cz)) this.#unload(key, held);
    for (const [key, job] of this.#loading) {
      const [cx, cy, cz] = key.split(',').map(Number);
      if (!this.#keeps(cx, cy, cz)) {
        job.abort();
        this.#loading.delete(key);
      }
    }
    for (const [key, held] of this.#ready) if (!this.#keeps(held.cx, held.cy, held.cz)) this.#ready.delete(key);
    for (const [key, spot] of this.#failed) if (!this.#keeps(spot.cx, spot.cy, spot.cz)) this.#failed.delete(key);
    // Ceilings of columns past every viewer's unload range go (any height: a column holds every layer).
    const far = (d + 1) * (d + 1);
    for (const column of this.#ceilings.keys()) {
      const [cx, cz] = column.split(',').map(Number);
      let kept = false;
      for (let i = 0; i < c.length && !kept; i += 3) kept = (cx - c[i]) ** 2 + (cz - c[i + 2]) ** 2 <= far;
      if (!kept) this.#ceilings.delete(column);
    }
  }
  // Make room for a load/admission: unload the least recently used chunks outside the load ring.
  #evict(reserve = 0): void {
    let total = 0;
    for (const held of this.#loaded.values()) total += held.chunk.byteLength;
    this.#mean = this.#loaded.size ? total / this.#loaded.size : 0;
    if (total + reserve > this.#budget)
      for (const [key, held] of [...this.#loaded]
        .filter(([key]) => !this.#ring.has(key))
        .sort((a, b) => a[1].used - b[1].used)) {
        if (total + reserve <= this.#budget) break;
        total -= held.chunk.byteLength;
        this.#unload(key, held);
      }
    this.#full = total > this.#budget;
    this.#room = this.#budget - total;
  }
  #add(): void {
    if (!this.#ready.size) return;
    this.#evict(); // edits and a changed budget may have changed the room since the last update
    const far = (key: string) => this.#ring.get(key)?.d ?? Infinity,
      queue = [...this.#ready].sort((a, b) => far(a[0]) - far(b[0])),
      start = performance.now();
    let added = 0;
    for (const [key, ready] of queue) {
      if (added === this.#perFrame || (added && performance.now() - start >= this.#frameBudget)) break;
      const { cx, cy, cz, edited } = ready;
      if (this.world.getChunk(cx, cy, cz)) {
        this.#ready.delete(key); // someone added one meanwhile: theirs stays
        continue;
      }
      let chunk: VoxelChunk;
      try {
        chunk = ready.chunk instanceof VoxelChunk ? ready.chunk : VoxelChunk.unpack(ready.chunk);
      } catch (error) {
        this.#ready.delete(key);
        this.#failed.set(key, ready); // a generator worker posted something that is not a PackedChunk
        this.onError(error);
        continue;
      }
      // Reservations use an estimate; stored/generated chunks can be larger. Keep the closest finished chunk
      // pending until it really fits, retaining the unpacked data and any unsaved edit while it waits.
      ready.chunk = chunk;
      if (chunk.byteLength > this.#room) this.#evict(chunk.byteLength);
      if (chunk.byteLength > this.#room) break;
      this.#ready.delete(key);
      if (edited) this.#unsaved.delete(key);
      this.#loaded.set(key, { cx, cy, cz, chunk, edited, used: this.#ring.has(key) ? this.#tick : 0 });
      this.world.addChunk(cx, cy, cz, chunk);
      this.#room -= chunk.byteLength;
      added++;
    }
  }
  // Starts loads closest first: at most 4 per worker running or queued, and none while as many finished chunks wait to
  // join as one update adds (at least 4 per worker), so a slow join does not pile chunks up. It runs each update and,
  // once chunks have joined, as each load finishes, so a worker never waits for the next frame. Every start reserves
  // room for all chunks on their way at the loaded chunks' mean size; admission checks the actual bytes separately.
  #start(between = false): void {
    if (this.#full || this.#disposed || (between && !this.#mean)) return;
    const waiting = Math.max(4 * this.workers, Math.min(this.#perFrame, 64));
    for (const order = this.#order; this.#next < order.length; this.#next++) {
      if (this.#loading.size >= 4 * this.workers || this.#ready.size >= waiting) return;
      const spot = order[this.#next],
        { key } = spot;
      if (this.#loaded.has(key) || this.#loading.has(key) || this.#ready.has(key) || this.#failed.has(key)) continue;
      const reserve = (this.#loading.size + this.#ready.size + 1) * this.#mean;
      if (reserve > this.#room && !between) this.#evict(reserve);
      if (reserve > this.#room) return;
      const kept = this.#unsaved.get(key);
      if (kept) this.#ready.set(key, kept);
      else this.#load(spot);
    }
  }
  // Store first, then the generator (air without one, and above its column's ceiling once a chunk of it told it).
  #load(spot: Spot): void {
    const { key, cx, cy, cz, d } = spot,
      job = new AbortController(),
      pool = this.#pool,
      column = `${cx},${cz}`;
    this.#loading.set(key, job);
    (async (): Promise<VoxelChunk | Generated> => {
      const stored = await this.store.get(cx, cy, cz);
      if (stored || !pool || cy * 32 > (this.#ceilings.get(column) ?? Infinity)) return stored ?? new VoxelChunk();
      job.signal.throwIfAborted();
      return pool.run<Generated>(() => ({ cx, cy, cz, blocks: this.world.blocks.table, terrain: this.#terrain }), {
        priority: d,
        signal: job.signal,
      });
    })().then(
      (chunk) => {
        if (this.#loading.get(key) !== job) return;
        this.#loading.delete(key);
        if (!(chunk instanceof VoxelChunk) && Number.isInteger(chunk.ceiling))
          this.#ceilings.set(column, chunk.ceiling as number);
        this.#ready.set(key, { cx, cy, cz, chunk, edited: false, used: 0 });
        this.#start(true);
      },
      (error) => {
        if (this.#loading.get(key) !== job) return;
        this.#loading.delete(key);
        this.#failed.set(key, spot);
        this.onError(error);
        this.#start(true);
      },
    );
  }
  #unload(key: string, held: Held): void {
    this.#loaded.delete(key);
    if (held.edited) this.#persist(key, held).catch((error) => this.onError(error));
    this.world.removeChunk(held.cx, held.cy, held.cz);
  }
  // Saves an unloaded edited chunk, keeping it in #unsaved (where loads look first) until the store has it.
  #persist(key: string, held: Held): Promise<void> {
    this.#unsaved.set(key, held);
    return this.store.put(held.cx, held.cy, held.cz, held.chunk).then(() => {
      if (this.#unsaved.get(key) === held) this.#unsaved.delete(key);
    });
  }
  async #save(): Promise<void> {
    const puts: Promise<void>[] = [];
    for (const held of this.#loaded.values())
      if (held.edited) {
        held.edited = false;
        puts.push(
          this.store.put(held.cx, held.cy, held.cz, held.chunk).catch((error) => {
            held.edited = true;
            throw error;
          }),
        );
      }
    for (const [key, held] of this.#unsaved) puts.push(this.#persist(key, held));
    const results = await Promise.allSettled(puts);
    await this.store.flush();
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}
