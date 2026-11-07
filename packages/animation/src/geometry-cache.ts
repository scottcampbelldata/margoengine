/// <reference lib="esnext.disposable" preserve="true" />
// Geometry cache playback: baked vertex animation from DCC tools (cloth, destruction, fluids) streamed in chunks. Each
// chunk carries its own topology, so a mesh may change vertex count as it plays. Only a few chunks are held at a time.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin } from '@margoengine/core/extension';
import { GLTFAsset, PBRModel, type GLTFDocument } from '@margoengine/gltf-pro/model';
import { MargoError } from '@margoengine/math/errors';

declare const GPUBufferUsage: { STORAGE: number; VERTEX: number; COPY_DST: number; COPY_SRC: number };

const FILE_HEADER = 16,
  CHUNK_HEADER = 64,
  FILE_MAGIC = 0x4843474d, // 'MGCH'
  CHUNK_MAGIC = 0x4b4e4843, // 'CHNK'
  VERSION = 1,
  HAS_NORMALS = 1,
  HAS_UVS = 2,
  /** Floats of one packed vertex. */
  STRIDE = 20;

/** One run of frames sharing a topology. Positions and normals hold `frameCount` frames of `vertexCount` vertices. */
export interface GeometryChunk {
  /** Frames per second of the cache. */
  rate: number;
  /** Frames in the whole cache, or 0 when the file does not say. */
  totalFrames: number;
  firstFrame: number;
  frameCount: number;
  vertexCount: number;
  indices: Uint32Array;
  /** Two floats per vertex; zero when the cache has none. */
  uvs: Float32Array;
  positions: Float32Array;
  normals: Float32Array;
  /** Min xyz then max xyz over every frame of the chunk. */
  bounds: Float32Array;
}

/** Bytes as they arrive: a `fetch` body, any async iterable, or one array. */
export type GeometryCacheBytes = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Uint8Array;

/** Options for {@link readGeometryCache}. */
export interface GeometryCacheReadOptions {
  /** Stops the read: the iterator rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Refuses a chunk larger than this, before allocating it. Default 1 GiB. */
  maxChunkBytes?: number;
}

const bad = (what: string) => new MargoError('failed', `Geometry cache ${what}; export the file again`);

async function* bytesOf(source: GeometryCacheBytes, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  // Safari's streams are not async iterable.
  if ('getReader' in source) {
    const reader = source.getReader();
    const stop = () => void reader.cancel(signal?.reason).catch(() => {});
    signal?.addEventListener('abort', stop, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      signal?.removeEventListener('abort', stop);
      // Left early, the body would keep downloading: a seek that restarts must not pay for the old read.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  yield* source;
}

/** Takes exact byte counts out of parts that arrive in any sizes. */
class ByteQueue {
  private parts: Uint8Array[] = [];
  private head = 0;
  size = 0;
  push(part: Uint8Array): void {
    this.parts.push(part);
    this.size += part.length;
  }
  take(count: number): Uint8Array {
    const out = new Uint8Array(count);
    for (let at = 0; at < count; ) {
      const part = this.parts[0],
        n = Math.min(part.length - this.head, count - at);
      out.set(part.subarray(this.head, this.head + n), at);
      at += n;
      this.head += n;
      if (this.head === part.length) {
        this.parts.shift();
        this.head = 0;
      }
    }
    this.size -= count;
    return out;
  }
}

/** A chunk's positions as a smooth normal per vertex, area weighted, for files that store none. */
function computeNormals(chunk: GeometryChunk): Float32Array {
  const { positions, indices, vertexCount, frameCount } = chunk,
    out = new Float32Array(positions.length);
  for (let f = 0; f < frameCount; f++) {
    const base = f * vertexCount * 3;
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const a = base + indices[t] * 3,
        b = base + indices[t + 1] * 3,
        c = base + indices[t + 2] * 3,
        ux = positions[b] - positions[a],
        uy = positions[b + 1] - positions[a + 1],
        uz = positions[b + 2] - positions[a + 2],
        vx = positions[c] - positions[a],
        vy = positions[c + 1] - positions[a + 1],
        vz = positions[c + 2] - positions[a + 2],
        x = uy * vz - uz * vy,
        y = uz * vx - ux * vz,
        z = ux * vy - uy * vx;
      for (const o of [a, b, c]) {
        out[o] += x;
        out[o + 1] += y;
        out[o + 2] += z;
      }
    }
  }
  for (let i = 0; i < out.length; i += 3) {
    const size = Math.hypot(out[i], out[i + 1], out[i + 2]);
    if (size > 0) {
      out[i] /= size;
      out[i + 1] /= size;
      out[i + 2] /= size;
    } else out[i + 2] = 1;
  }
  return out;
}

/**
 * Reads a geometry cache as it arrives, one chunk per step, holding no more than the chunk being read. A chunk with no
 * indices or UVs repeats the previous chunk's. Rejects with a `failed` MargoError on a damaged or cut off file.
 *
 * @example
 * ```ts
 * const response = await fetch('/flag.mgc');
 * for await (const chunk of readGeometryCache(response.body!)) console.log(chunk.firstFrame, chunk.vertexCount);
 * ```
 */
export async function* readGeometryCache(
  source: GeometryCacheBytes,
  { signal, maxChunkBytes = 2 ** 30 }: GeometryCacheReadOptions = {},
): AsyncGenerator<GeometryChunk, void, undefined> {
  const queue = new ByteQueue();
  let rate = 0,
    total = 0,
    next = 0,
    header: DataView | undefined,
    previous: GeometryChunk | undefined;
  const chunk = (payload: Uint8Array, h: DataView): GeometryChunk => {
    const frameCount = h.getUint32(12, true),
      vertexCount = h.getUint32(16, true),
      indexCount = h.getUint32(20, true),
      flags = h.getUint32(24, true),
      buffer = payload.buffer as ArrayBuffer;
    let at = 0;
    const floats = (count: number) => {
        const view = new Float32Array(buffer, at, count);
        at += count * 4;
        return view;
      },
      indices = indexCount ? new Uint32Array(buffer, 0, indexCount) : previous?.indices;
    at = indexCount * 4;
    if (!indices) throw bad('starts with a chunk that has no indices');
    for (let i = 0; i < indices.length; i++) if (indices[i] >= vertexCount) throw bad('has an index past its vertices');
    const uvs =
        flags & HAS_UVS
          ? floats(vertexCount * 2)
          : previous?.uvs.length === vertexCount * 2
            ? previous.uvs
            : new Float32Array(vertexCount * 2),
      positions = floats(frameCount * vertexCount * 3),
      read: GeometryChunk = {
        rate,
        totalFrames: total,
        firstFrame: h.getUint32(8, true),
        frameCount,
        vertexCount,
        indices,
        uvs,
        positions,
        normals: positions,
        bounds: new Float32Array(6),
      };
    for (let i = 0; i < 6; i++) read.bounds[i] = h.getFloat32(32 + i * 4, true);
    read.normals = flags & HAS_NORMALS ? floats(frameCount * vertexCount * 3) : computeNormals(read);
    for (const list of [positions, read.normals])
      for (let i = 0; i < list.length; i++) if (!Number.isFinite(list[i])) throw bad('holds a non-finite vertex');
    return read;
  };
  for await (const part of bytesOf(source, signal)) {
    signal?.throwIfAborted();
    queue.push(part);
    for (;;) {
      if (!rate) {
        if (queue.size < FILE_HEADER) break;
        const h = queue.take(FILE_HEADER),
          view = new DataView(h.buffer);
        if (view.getUint32(0, true) !== FILE_MAGIC) throw bad('has the wrong magic number');
        if (view.getUint32(4, true) !== VERSION) throw bad(`has unknown version ${view.getUint32(4, true)}`);
        rate = view.getFloat32(8, true);
        total = view.getUint32(12, true);
        if (!(rate > 0 && Number.isFinite(rate))) throw bad('has no frame rate');
      }
      if (!header) {
        if (queue.size < CHUNK_HEADER) break;
        const h = new DataView(queue.take(CHUNK_HEADER).buffer),
          frames = h.getUint32(12, true),
          vertices = h.getUint32(16, true),
          indices = h.getUint32(20, true),
          flags = h.getUint32(24, true),
          want =
            indices * 4 +
            (flags & HAS_UVS ? vertices * 8 : 0) +
            frames * vertices * (flags & HAS_NORMALS ? 24 : 12);
        if (h.getUint32(0, true) !== CHUNK_MAGIC) throw bad('has a damaged chunk header');
        if (!frames || vertices < 3 || vertices > 1_000_000 || indices % 3)
          throw bad('has a chunk with no frames, a broken triangle list, or not 3 to 1,000,000 vertices');
        if (h.getUint32(8, true) !== next) throw bad(`skips from frame ${next} to ${h.getUint32(8, true)}`);
        if (h.getUint32(4, true) !== want) throw bad('has a chunk of the wrong size');
        if (want > maxChunkBytes)
          throw new RangeError(`Geometry chunk of ${want} bytes is over maxChunkBytes; raise it or export smaller chunks`);
        header = h;
      }
      const size = header.getUint32(4, true);
      if (queue.size < size) break;
      const read = chunk(queue.take(size), header);
      header = undefined;
      previous = read;
      next += read.frameCount;
      yield read;
      signal?.throwIfAborted();
    }
  }
  if (!rate || header || queue.size) throw bad('ends inside a chunk');
  if (total && next !== total) throw bad(`ends at frame ${next} of ${total}`);
}

/** One chunk to write: frames of positions, with normals and UVs when the file should carry them. */
export interface GeometryChunkInput {
  frameCount: number;
  /** `frameCount` frames of three floats per vertex. */
  positions: Float32Array;
  /** Leave out to repeat the last chunk's topology. */
  indices?: Uint32Array;
  /** Same shape as `positions`. Default: computed when read. */
  normals?: Float32Array;
  /** Two floats per vertex. Default: the last chunk's if it has as many vertices, else zero. */
  uvs?: Float32Array;
}

/** Writes a geometry cache (format in the package README). Chunks of about a second stream well. */
export function encodeGeometryCache(rate: number, chunks: readonly GeometryChunkInput[]): Uint8Array {
  if (!(rate > 0 && Number.isFinite(rate)) || !chunks.length)
    throw new RangeError('Invalid geometry cache; pass a frame rate above 0 and at least one chunk');
  const parts: Uint8Array[] = [],
    head = new DataView(new ArrayBuffer(FILE_HEADER));
  let frames = 0;
  head.setUint32(0, FILE_MAGIC, true);
  head.setUint32(4, VERSION, true);
  head.setFloat32(8, rate, true);
  parts.push(new Uint8Array(head.buffer));
  for (const { frameCount, positions, indices, normals, uvs } of chunks) {
    const vertexCount = positions.length / 3 / frameCount;
    if (
      !Number.isInteger(frameCount) ||
      frameCount < 1 ||
      !Number.isInteger(vertexCount) ||
      vertexCount < 1 ||
      (normals && normals.length !== positions.length) ||
      (uvs && uvs.length !== vertexCount * 2) ||
      (indices && indices.length % 3)
    )
      throw new RangeError(
        'Invalid geometry chunk; give positions and normals frameCount frames of 3 floats per vertex, 2 UV floats per vertex and whole triangles',
      );
    const arrays = [indices, uvs, positions, normals].filter((a) => a !== undefined),
      size = arrays.reduce((n, a) => n + a.byteLength, 0),
      h = new DataView(new ArrayBuffer(CHUNK_HEADER)),
      low = [Infinity, Infinity, Infinity],
      high = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i++) {
      low[i % 3] = Math.min(low[i % 3], positions[i]);
      high[i % 3] = Math.max(high[i % 3], positions[i]);
    }
    h.setUint32(0, CHUNK_MAGIC, true);
    h.setUint32(4, size, true);
    h.setUint32(8, frames, true);
    h.setUint32(12, frameCount, true);
    h.setUint32(16, vertexCount, true);
    h.setUint32(20, indices?.length ?? 0, true);
    h.setUint32(24, (normals ? HAS_NORMALS : 0) | (uvs ? HAS_UVS : 0), true);
    [...low, ...high].forEach((value, i) => h.setFloat32(32 + i * 4, value, true));
    parts.push(new Uint8Array(h.buffer));
    for (const a of arrays) parts.push(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    frames += frameCount;
  }
  head.setUint32(12, frames, true);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Where a cache comes from. A URL, an array or a function can start again; a stream cannot, so it keeps what it read. */
export type GeometryCacheSource = string | URL | GeometryCacheBytes | ((signal: AbortSignal) => GeometryCacheBytes);

/** Options for {@link GeometryCachePlayer.attach}. */
export interface GeometryCachePlayerOptions {
  /** Start over at the end. Default true. */
  loop?: boolean;
  /** Playback rate multiplier, finite and >= 0. Default 1. */
  speed?: number;
  /** Chunks to read ahead of the one playing, at least 1. Default 2. */
  ahead?: number;
  /** Stops the stream; the player keeps the frame it has. */
  signal?: AbortSignal;
  /** A glTF material for the mesh. Default: plain white. */
  material?: NonNullable<GLTFDocument['materials']>[number];
  /** See {@link GeometryCacheReadOptions.maxChunkBytes}. */
  maxChunkBytes?: number;
}

/** What the player has done so far. */
export interface GeometryCacheStats {
  /** Frames written to the GPU. */
  uploads: number;
  /** Frames the clock waited because the chunk had not arrived. */
  stalls: number;
  /** Chunks read, restarts included. */
  chunks: number;
  /** Times the mesh changed topology. */
  swaps: number;
}

let serial = 0;
const sameArray = (a: Uint32Array, b: Uint32Array) => a === b || (a.length === b.length && a.every((v, i) => v === b[i]));

/**
 * Plays a geometry cache on a mesh of its own (`player.model`), reading chunks only as far ahead as `ahead`. The clock
 * waits when the stream falls behind, so playback never jumps. Between two frames of one topology the vertices
 * interpolate; a chunk with another topology swaps the mesh at its first frame.
 *
 * @example
 * ```ts
 * const flag = await GeometryCachePlayer.attach(stage.engine, '/flag.mgc');
 * flag.model.root.setPosition([0, 2, 0]);
 * ```
 */
export class GeometryCachePlayer implements EnginePlugin {
  readonly name = 'geometry-cache:' + serial++;
  /** Seconds played. Set it, or call {@link seek}, to move. */
  time = 0;
  playing = true;
  speed: number;
  loop: boolean;
  /** The mesh being played. The player owns it: dispose the player, not the model. */
  readonly model: PBRModel;
  readonly stats: GeometryCacheStats = { uploads: 0, stalls: 0, chunks: 0, swaps: 0 };
  /** Settles when the stream has been read to its end, which follows the clock by `ahead` chunks; rejects if reading fails. */
  readonly done: Promise<void>;
  /** Why reading stopped early, if it did. */
  failure?: unknown;
  disposed = false;
  private engine?: Engine;
  private buffer?: GPUBuffer;
  private capacity = 0;
  private scratch: Float32Array;
  private installed: GeometryChunk;
  private chunks: GeometryChunk[];
  /** The frame the reader delivers next. */
  private readTo = 0;
  /** Frames in the whole cache, once the end has been read. */
  private frames = Infinity;
  private shown = '';
  /** Ends a reader when a seek restarts it. */
  private reader = 0;
  private wake?: () => void;
  private settle!: (error?: unknown) => void;
  private readonly ahead: number;

  /** Reads the first chunk, then adds the mesh and the player to the engine. */
  static async attach(
    engine: EngineKernel,
    source: GeometryCacheSource,
    options: GeometryCachePlayerOptions = {},
  ): Promise<GeometryCachePlayer> {
    const { ahead = 2, speed = 1, signal, maxChunkBytes } = options;
    if (!Number.isInteger(ahead) || ahead < 1 || !Number.isFinite(speed) || speed < 0)
      throw new RangeError('Invalid geometry cache options; ahead must be a whole number >= 1 and speed a finite number >= 0');
    if (!(engine as Engine).gpu)
      throw new MargoError('unsupported', 'GeometryCachePlayer needs WebGPU; create the engine with the webgpu backend');
    const abort = new AbortController(),
      stop = () => abort.abort(signal!.reason);
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
    const open = () => readGeometryCache(bytes(source, abort.signal), { signal: abort.signal, maxChunkBytes }),
      iterator = open(),
      first = await iterator.next();
    if (first.done) throw bad('holds no chunks');
    const rewinds =
      typeof source === 'string' ||
      typeof source === 'function' ||
      source instanceof URL ||
      source instanceof Uint8Array;
    return new GeometryCachePlayer(engine as Engine, first.value, iterator, open, abort, options, rewinds);
  }
  private constructor(
    engine: Engine,
    first: GeometryChunk,
    iterator: AsyncGenerator<GeometryChunk, void, undefined>,
    private readonly open: () => AsyncGenerator<GeometryChunk, void, undefined>,
    private readonly abort: AbortController,
    { ahead = 2, speed = 1, loop = true, material }: GeometryCachePlayerOptions,
    private readonly rewinds: boolean,
  ) {
    this.ahead = ahead;
    this.speed = speed;
    this.loop = loop;
    this.chunks = [first];
    this.installed = first;
    this.stats.chunks = 1;
    this.readTo = first.frameCount;
    if (first.totalFrames) this.frames = first.totalFrames;
    this.scratch = new Float32Array(first.vertexCount * STRIDE);
    this.pack(first);
    this.model = new PBRModel(
      engine,
      new GLTFAsset(
        {
          asset: { version: '2.0' },
          materials: [material ?? {}],
          meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
          nodes: [{ mesh: 0 }],
        },
        [],
      ),
      [],
      [[{ vertices: this.scratch.slice(), indices: first.indices }]],
    );
    this.done = new Promise((resolve, reject) => {
      this.settle = (error) => (error === undefined ? resolve() : reject(error));
    });
    this.done.catch(() => {});
    engine.use(this.model);
    engine.use(this);
    void this.pump(iterator, this.reader);
  }
  setup(engine: Engine): void {
    this.engine = engine;
    this.bind(engine.gpu!);
  }
  /** Seconds in the whole cache, or Infinity until the stream has ended. */
  get duration(): number {
    return this.frames / this.installed.rate;
  }
  /** Min xyz then max xyz of the chunk playing, over all its frames. */
  get bounds(): Float32Array {
    return this.installed.bounds;
  }
  /** Moves the clock. A place the player no longer holds starts the stream again, if it can. */
  seek(seconds: number): this {
    if (!Number.isFinite(seconds) || seconds < 0)
      throw new RangeError('Invalid geometry cache time; pass finite seconds >= 0');
    this.time = seconds;
    return this;
  }
  onPreUpdate(delta: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid geometry cache delta; pass finite seconds >= 0');
    const before = this.time,
      rate = this.installed.rate;
    if (this.playing) this.time += delta * this.speed;
    let at = this.time * rate,
      wrapped = false;
    if (at >= this.frames) {
      if (this.loop) {
        at %= this.frames;
        this.time = at / rate;
        wrapped = true;
      } else {
        at = this.frames - 1;
        this.time = this.frames / rate;
        this.playing = false;
      }
    }
    const frame = Math.floor(at),
      chunk = this.find(frame);
    // A new lap reads again at once, while the first chunk plays, so the wrap does not wait for the network.
    if (wrapped && this.failure === undefined && this.rewinds && !this.holdsAll()) this.restart();
    if (!chunk) {
      // The clock waits for the data, so playback never jumps.
      this.time = before;
      if (this.failure === undefined) {
        this.stats.stalls++;
        // Behind the reader: only a new read reaches it. Ahead of it: the reader is on its way.
        if (this.rewinds && frame < this.readTo) this.restart();
      }
      this.wake?.();
      return;
    }
    this.show(chunk, frame, at - frame);
    this.drop(frame);
    this.wake?.();
  }
  onDeviceRestored(engine: Engine): void {
    this.buffer = undefined;
    this.capacity = 0;
    this.shown = '';
    this.bind(engine.gpu!);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reader++;
    this.abort.abort(new MargoError('disposed', 'GeometryCachePlayer is disposed; attach the cache again'));
    this.wake?.();
    this.settle();
    this.engine?.removePlugin(this.name);
    this.model.primitives[0].deformed = undefined;
    this.buffer?.destroy();
    this.buffer = undefined;
    this.model.dispose();
    this.chunks = [];
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  private find(frame: number): GeometryChunk | undefined {
    return this.chunks.find((c) => frame >= c.firstFrame && frame < c.firstFrame + c.frameCount);
  }
  private holdsAll(): boolean {
    return this.chunks.reduce((frames, c) => frames + c.frameCount, 0) >= this.frames;
  }
  /** The chunk that opens the next lap stays, so that a wrap can show it at once. */
  private pinned(chunk: GeometryChunk): boolean {
    return this.loop && chunk.firstFrame === 0;
  }
  /** Lets go of chunks already played, when they can be read again. */
  private drop(frame: number): void {
    if (this.rewinds)
      this.chunks = this.chunks.filter(
        (c) => c.firstFrame + c.frameCount > frame || c === this.installed || this.pinned(c),
      );
  }
  /** Chunks held unbroken after the one playing. One held further on, past a gap, does not stop the reader. */
  private behind(): number {
    let frame = Math.floor(this.time * this.installed.rate),
      count = -1;
    if (!this.find(frame)) count = 0;
    for (let chunk = this.find(frame); chunk; chunk = this.find(frame)) {
      frame = chunk.firstFrame + chunk.frameCount;
      count++;
    }
    return count;
  }
  private async pump(iterator: AsyncGenerator<GeometryChunk, void, undefined>, reader: number): Promise<void> {
    try {
      for (;;) {
        while (reader === this.reader && this.behind() >= this.ahead)
          await new Promise<void>((resolve) => (this.wake = resolve));
        if (reader !== this.reader) break;
        const { done, value } = await iterator.next();
        if (reader !== this.reader) break;
        if (done) {
          this.frames = this.readTo;
          this.settle();
          return;
        }
        this.stats.chunks++;
        this.readTo = value.firstFrame + value.frameCount;
        // A restart reads from the top: what ends before the clock is not needed.
        const needed =
          !this.rewinds || value.firstFrame + value.frameCount > Math.floor(this.time * this.installed.rate);
        if (needed && !this.chunks.some((c) => c.firstFrame === value.firstFrame)) {
          this.chunks.push(value);
          this.chunks.sort((a, b) => a.firstFrame - b.firstFrame);
        }
      }
      void iterator.return();
    } catch (error) {
      if (reader !== this.reader) return;
      this.failure = error;
      this.settle(error);
    }
  }
  private restart(): void {
    this.reader++;
    this.readTo = 0;
    this.wake?.();
    this.chunks = this.chunks.filter((c) => this.pinned(c));
    void this.pump(this.open(), this.reader);
  }
  /** Writes the frame's vertices into `scratch`. Position and normal only: the rest is the chunk's. */
  private pack(chunk: GeometryChunk, a = 0, next = chunk, b = 0, w = 0): void {
    const out = this.scratch,
      n = chunk.vertexCount,
      from = a * n * 3,
      to = b * n * 3,
      p = chunk.positions,
      q = next.positions,
      m = chunk.normals,
      l = next.normals;
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE,
        s = from + i * 3,
        t = to + i * 3;
      let nx = m[s] + (l[t] - m[s]) * w,
        ny = m[s + 1] + (l[t + 1] - m[s + 1]) * w,
        nz = m[s + 2] + (l[t + 2] - m[s + 2]) * w;
      const size = Math.hypot(nx, ny, nz);
      if (size > 0) {
        nx /= size;
        ny /= size;
        nz /= size;
      } else nz = 1;
      out[o] = p[s] + (q[t] - p[s]) * w;
      out[o + 1] = p[s + 1] + (q[t + 1] - p[s + 1]) * w;
      out[o + 2] = p[s + 2] + (q[t + 2] - p[s + 2]) * w;
      out[o + 3] = 1;
      out[o + 4] = nx;
      out[o + 5] = ny;
      out[o + 6] = nz;
      out[o + 12] = chunk.uvs[i * 2];
      out[o + 13] = chunk.uvs[i * 2 + 1];
      out[o + 16] = out[o + 17] = out[o + 18] = out[o + 19] = 1;
    }
  }
  private show(chunk: GeometryChunk, frame: number, w: number): void {
    const local = frame - chunk.firstFrame,
      key = chunk.firstFrame + ':' + local + ':' + w;
    if (key === this.shown) return;
    let next = chunk,
      to = local + 1;
    if (to === chunk.frameCount) {
      const after = this.find(chunk.firstFrame + chunk.frameCount);
      // The next chunk only continues this one if it has the same mesh. Otherwise hold until it swaps in.
      if (after && after.vertexCount === chunk.vertexCount && sameArray(after.indices, chunk.indices)) {
        next = after;
        to = 0;
      } else {
        to = local;
      }
    }
    if (this.installed.vertexCount !== chunk.vertexCount || !sameArray(this.installed.indices, chunk.indices))
      this.swap(chunk);
    this.installed = chunk;
    this.pack(chunk, local, next, to, w);
    const device = this.engine!.gpu!;
    device.queue.writeBuffer(this.buffer!, 0, this.scratch as Float32Array<ArrayBuffer>);
    this.shown = key;
    this.stats.uploads++;
  }
  /** Another topology: the mesh takes this chunk's vertices and triangles, and the output buffer grows if it must. */
  private swap(chunk: GeometryChunk): void {
    const primitive = this.model.primitives[0];
    this.scratch = new Float32Array(chunk.vertexCount * STRIDE);
    this.pack(chunk);
    primitive.deformed = undefined;
    this.model.writeGeometry([{ vertices: this.scratch.slice(), indices: chunk.indices }]);
    this.bind(this.engine!.gpu!);
    this.stats.swaps++;
  }
  private bind(device: GPUDevice): void {
    const primitive = this.model.primitives[0];
    if (this.scratch.byteLength > this.capacity) {
      this.buffer?.destroy();
      this.capacity = this.scratch.byteLength;
      this.buffer = device.createBuffer({
        size: this.capacity,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });
    }
    primitive.deformed = this.buffer;
    primitive.deformedOffset = 0;
    device.queue.writeBuffer(this.buffer!, 0, this.scratch as Float32Array<ArrayBuffer>);
  }
}

function bytes(source: GeometryCacheSource, signal: AbortSignal): GeometryCacheBytes {
  if (typeof source === 'function') return source(signal);
  if (typeof source !== 'string' && !(source instanceof URL)) return source;
  return (async function* () {
    const response = await fetch(source, { signal });
    if (!response.ok || !response.body)
      throw new MargoError('failed', `Geometry cache request failed with status ${response.status}; check the URL`);
    yield* bytesOf(response.body, signal);
  })();
}
