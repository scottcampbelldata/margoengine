// Streamed levels: a level that lives on the network until the camera needs it. `LODSystem` asks a level with `request()`
// when it wants to show it, and holds the level it has until the answer is yes; this entry fetches at most `concurrency`
// at a time, drops a fetch nobody asks for any more, and frees the longest unused levels past `maxBytes`.
import type { EngineKernel, Mesh } from '@margoengine/core';
import { meshRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import type { PBRModel } from '@margoengine/gltf-pro';
import { MargoError } from '@margoengine/math/errors';
import type { DeferredLevel } from './index.js';

/** What a level's loader gives: a core mesh, or a model with a `root` (gltf-pro, materials). The stream owns it from then on. */
export type StreamedObject = Mesh | { readonly root: Mesh; dispose(): void };
/** A glTF or GLB URL, loaded with `loadGLTF`, or a loader of your own, which must honour `signal`. */
export type LevelSource = string | URL | ((signal: AbortSignal) => Promise<StreamedObject>);
/** Options of {@link LevelStream}. */
export interface LevelStreamOptions {
  /** Bytes of levels kept loaded; past it the longest unused ones are freed. Levels on show always stay. Default 256 MiB. */
  maxBytes?: number;
  /** Levels fetched at once, 1 or more. Default 4. */
  concurrency?: number;
}
/** Options of {@link LevelStream.level}. */
export interface StreamedLevelOptions {
  /** What the level counts for against `maxBytes`. Default: the vertices and indices it holds once loaded. */
  bytes?: number;
  /** Parent of the loaded object, usually the LOD's anchor. Default none. */
  parent?: Mesh;
}
/** Where a level is: not loaded, waiting its turn, fetching, ready to show, or failed until `retry()`. */
export type StreamedLevelState = 'idle' | 'queued' | 'loading' | 'ready' | 'failed';

const target = (o: StreamedObject): Mesh => ('root' in o ? o.root : (o as Mesh));
/** Vertex and index bytes of a loaded object, each shared buffer once. */
function measure(object: StreamedObject): number {
  const seen = new Set<ArrayBufferLike>();
  let total = 0;
  const add = (data?: ArrayBufferView) => {
    if (data && !seen.has(data.buffer)) {
      seen.add(data.buffer);
      total += data.byteLength;
    }
  };
  const primitives = (object as Partial<PBRModel>).primitives;
  if (primitives)
    for (const p of primitives) {
      add(p.vertices);
      add(p.indices);
    }
  else {
    const geometry = meshRuntime(object as Mesh).geometry;
    add(geometry?.vertices);
    add(geometry?.indices);
  }
  return total;
}

/** One level of a {@link LevelStream}: use it as a level's `object`. */
export class StreamedLevel implements DeferredLevel {
  /** Where the level is now. */
  state: StreamedLevelState = 'idle';
  /** Why the last fetch failed; undefined otherwise. */
  error: unknown;
  /** What the level counts for against `maxBytes`: the option, or what it held when it loaded. 0 before that. */
  bytes: number;
  /** The loaded object while `state` is `'ready'`. */
  object?: StreamedObject;
  private shown = false;
  /** @internal */ asked = 0;
  /** @internal */ used = 0;
  /** @internal */ controller?: AbortController;
  /** @internal */ constructor(
    private readonly stream: LevelStream,
    /** @internal */ readonly source: LevelSource,
    /** @internal */ readonly options: StreamedLevelOptions,
  ) {
    this.bytes = options.bytes ?? 0;
  }
  /** The loaded gltf-pro or materials model, for `@margoengine/lod/fade`; undefined otherwise. */
  get model(): PBRModel | undefined {
    return (this.object as Partial<PBRModel> | undefined)?.primitives ? (this.object as PBRModel) : undefined;
  }
  get visible(): boolean {
    return this.shown;
  }
  set visible(value: boolean) {
    this.shown = value;
    if (this.object) target(this.object).visible = value;
  }
  /** True when the level can show; otherwise starts or keeps its fetch. `LODSystem` calls this. */
  request(): boolean {
    return this.stream.ask(this);
  }
  /** After a failure: lets the next `request()` fetch again. */
  retry(): void {
    if (this.state !== 'failed') return;
    this.state = 'idle';
    this.error = undefined;
  }
}

/**
 * Fetches LOD levels when they are wanted, for scenes too big to load at once. Give a level a coarse neighbour that needs
 * no fetch, or the object shows nothing until its first level arrives.
 * @throws RangeError for options out of range.
 */
export class LevelStream implements EnginePlugin {
  readonly name: string;
  maxBytes: number;
  concurrency: number;
  private engine?: Engine;
  private frame = 1;
  private readonly levels = new Set<StreamedLevel>();
  private readonly queue: StreamedLevel[] = [];
  private loading = 0;
  private static serial = 0;
  /** Same as `engine.use(new LevelStream(options))`; returns the LevelStream. */
  static attach(engine: EngineKernel, options?: LevelStreamOptions): LevelStream {
    const value = new LevelStream(options);
    engine.use(value);
    return value;
  }
  constructor({ maxBytes = 256 * 1024 * 1024, concurrency = 4 }: LevelStreamOptions = {}) {
    if (!(maxBytes >= 0 && maxBytes < Infinity) || !Number.isInteger(concurrency) || concurrency < 1)
      throw new RangeError('Invalid LevelStream options; give maxBytes of 0 or more and a whole concurrency of 1 or more');
    this.maxBytes = maxBytes;
    this.concurrency = concurrency;
    this.name = 'lod-stream:' + LevelStream.serial++;
  }
  setup(engine: Engine): void {
    this.engine = engine;
  }
  /** Bytes of the levels loaded now. */
  get resident(): number {
    let total = 0;
    for (const level of this.levels) if (level.state === 'ready') total += level.bytes;
    return total;
  }
  /** Levels fetching now. */
  get active(): number {
    return this.loading;
  }
  /** The levels whose last fetch failed, for a retry or a report. */
  get failed(): StreamedLevel[] {
    return [...this.levels].filter((level) => level.state === 'failed');
  }
  /**
   * A level to pass as a level's `object`. Nothing is fetched until the level is wanted.
   * @throws RangeError for `bytes` below 0; TypeError for a source that is no URL or function.
   */
  level(source: LevelSource, options: StreamedLevelOptions = {}): StreamedLevel {
    if (typeof source !== 'string' && typeof source !== 'function' && !(source instanceof URL))
      throw new TypeError('A streamed level needs a URL or a loader function; pass one of those');
    if (options.bytes !== undefined && !(options.bytes >= 0 && options.bytes < Infinity))
      throw new RangeError('Invalid level bytes; pass 0 or more');
    const level = new StreamedLevel(this, source, options);
    this.levels.add(level);
    return level;
  }
  /** Stops managing `level`: its fetch ends and what it holds is freed. */
  remove(level: StreamedLevel): void {
    this.levels.delete(level);
    this.reset(level);
  }
  /** @internal */ ask(level: StreamedLevel): boolean {
    level.asked = this.frame;
    if (level.state === 'ready') {
      level.used = this.frame;
      return true;
    }
    if (level.state === 'idle' && this.levels.has(level)) {
      level.state = 'queued';
      this.queue.push(level);
      this.drain();
    }
    return false;
  }
  private drain(): void {
    while (this.loading < this.concurrency && this.queue.length) void this.fetch(this.queue.shift()!);
  }
  private async fetch(level: StreamedLevel): Promise<void> {
    const controller = (level.controller = new AbortController()),
      { signal } = controller,
      { source, options } = level;
    level.state = 'loading';
    this.loading++;
    let object: StreamedObject | undefined;
    try {
      if (!this.engine) throw new MargoError('state', 'Use the LevelStream on an engine first');
      if (typeof source === 'function') object = await source(signal);
      else {
        const { loadGLTF } = await import('@margoengine/gltf-pro');
        object = await loadGLTF(this.engine, source, { signal });
      }
      signal.throwIfAborted();
      target(object).visible = level.visible;
      if (options.parent) target(object).setParent(options.parent);
      level.object = object;
      level.bytes = options.bytes ?? measure(object);
      level.used = this.frame;
      level.state = 'ready';
      this.evict();
    } catch (error) {
      if (object) dispose(object);
      if (!signal.aborted) {
        level.state = 'failed';
        level.error = error;
      }
    } finally {
      if (level.controller === controller) level.controller = undefined;
      this.loading--;
      this.drain();
    }
  }
  private reset(level: StreamedLevel): void {
    level.controller?.abort();
    level.controller = undefined;
    const at = this.queue.indexOf(level);
    if (at >= 0) this.queue.splice(at, 1);
    if (level.object) dispose(level.object);
    level.object = undefined;
    level.bytes = level.options.bytes ?? 0;
    level.state = 'idle';
  }
  /** Frees the longest unused levels until the rest fit; a level on show stays, whatever it costs. */
  private evict(): void {
    let total = this.resident;
    if (total <= this.maxBytes) return;
    const spare = [...this.levels]
      .filter((level) => level.state === 'ready' && !level.visible && level.asked < this.frame)
      .sort((a, b) => a.used - b.used);
    for (const level of spare) {
      if (total <= this.maxBytes) return;
      total -= level.bytes;
      this.reset(level);
    }
  }
  onPreUpdate(): void {
    this.frame++;
    for (const level of this.levels) {
      // A level on show counts as used, though nothing asks for it while it stays on show.
      if (level.visible) level.used = this.frame;
      // Two frames: the plugins' order decides whether this runs before or after the system asks.
      if ((level.state === 'loading' || level.state === 'queued') && this.frame - level.asked > 2) this.reset(level);
    }
    this.evict();
  }
  /** Ends every fetch and frees every level. */
  dispose(): void {
    for (const level of this.levels) this.reset(level);
    this.levels.clear();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
const dispose = (object: StreamedObject) => {
  (object as { dispose(): void }).dispose();
};
