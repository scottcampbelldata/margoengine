import { rangeError } from '../../shared/errors.js';
import { geoTileAncestors, geoTileKey, type GeoTile } from './geo-lod-plan.js';

/** One cached value and the time it became available, in caller-supplied seconds. */
export interface GeoTileResident<T> {
  readonly tile: GeoTile;
  readonly value: T;
  readonly loadedAt: number;
}
/** Bounded asynchronous tile cache. Loads use signals and stale completions are never installed. */
export class GeoTileCache<T> {
  readonly #load: (tile: GeoTile, signal: AbortSignal) => Promise<T | undefined>;
  readonly #drop: (value: T) => void;
  readonly #capacity: number;
  readonly #concurrency: number;
  readonly #resident = new Map<string, GeoTileResident<T>>();
  readonly #pending = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  readonly #failed = new Map<string, unknown>();
  readonly #missing = new Set<string>();
  readonly #lifetime = new AbortController();
  #wanted: GeoTile[] = [];
  #selected: readonly GeoTile[] = [];
  #disposed = false;
  #now = 0;
  #external: AbortSignal | undefined;
  readonly #abort = () => this.dispose();
  constructor(
    load: (tile: GeoTile, signal: AbortSignal) => Promise<T | undefined>,
    options: {
      /** Cache tile count, default 128, including active tiles. */
      readonly capacity?: number;
      /** Simultaneous requests, default 6. */
      readonly concurrency?: number;
      readonly drop?: (value: T) => void;
      readonly signal?: AbortSignal;
    } = {},
  ) {
    this.#capacity = options.capacity ?? 128;
    this.#concurrency = options.concurrency ?? 6;
    if (
      !Number.isInteger(this.#capacity) ||
      this.#capacity < 1 ||
      !Number.isInteger(this.#concurrency) ||
      this.#concurrency < 1 ||
      this.#concurrency > 64
    )
      throw rangeError('Tile cache needs positive capacity and concurrency 1..64', 'sciviz');
    this.#load = load;
    this.#drop = options.drop ?? (() => {});
    options.signal?.throwIfAborted();
    this.#external = options.signal;
    this.#external?.addEventListener('abort', this.#abort, { once: true });
  }
  /** Selected leaves. */
  get selected(): readonly GeoTile[] {
    return this.#selected;
  }
  /** Cached tiles, least recently selected first. */
  get residents(): readonly GeoTileResident<T>[] {
    return [...this.#resident.values()];
  }
  /** First request failure, surfaced by ready(). Missing tiles are counted separately. */
  get error(): unknown {
    return this.#failed.values().next().value;
  }
  get missing(): number {
    return this.#missing.size;
  }
  get pending(): number {
    return this.#pending.size;
  }
  /** Sets the visible leaves. Root fallback is requested first; existing values survive camera changes. */
  update(tiles: readonly GeoTile[], now = 0): void {
    this.#external?.throwIfAborted();
    if (this.#disposed) return;
    if (tiles.length + 1 > this.#capacity)
      throw rangeError('Cache capacity must exceed the selected tile budget for root fallback', 'sciviz');
    if (!Number.isFinite(now)) throw rangeError('Tile clock must be finite seconds', 'sciviz');
    this.#now = now;
    this.#selected = tiles;
    const all = new Map<string, GeoTile>();
    if (tiles.length) all.set('0/0/0', { z: 0, x: 0, y: 0 });
    for (const t of tiles) all.set(geoTileKey(t), t);
    this.#wanted = [...all.values()];
    for (const [key, p] of this.#pending) if (!all.has(key)) p.controller.abort();
    for (const tile of this.#wanted) {
      const key = geoTileKey(tile),
        entry = this.#resident.get(key);
      if (entry) {
        this.#resident.delete(key);
        this.#resident.set(key, entry);
      }
    }
    // Failed/missing metadata is bounded to the current request set too.
    for (const key of this.#failed.keys()) if (!all.has(key)) this.#failed.delete(key);
    for (const key of this.#missing) if (!all.has(key)) this.#missing.delete(key);
    this.#pump();
  }
  #pump(): void {
    if (this.#disposed) return;
    for (const tile of this.#wanted) {
      if (this.#pending.size >= this.#concurrency) break;
      const key = geoTileKey(tile);
      if (this.#resident.has(key) || this.#pending.has(key) || this.#failed.has(key) || this.#missing.has(key))
        continue;
      const controller = new AbortController();
      // Start in a microtask, so the pending slot is installed even if a loader throws synchronously.
      const promise = Promise.resolve()
        .then(() => this.#load(tile, controller.signal))
        .then(
          (value) => {
            if (controller.signal.aborted || this.#disposed) {
              if (value !== undefined) this.#drop(value);
              return;
            }
            if (value === undefined) this.#missing.add(key);
            else this.#resident.set(key, { tile, value, loadedAt: this.#now });
          },
          (error) => {
            if (!controller.signal.aborted && !this.#disposed) this.#failed.set(key, error);
          },
        )
        .finally(() => {
          this.#pending.delete(key);
          this.#evict();
          this.#pump();
        });
      this.#pending.set(key, { controller, promise });
    }
  }
  #evict(): void {
    const active = new Set(this.#wanted.map(geoTileKey));
    for (const [key, entry] of this.#resident) {
      if (this.#resident.size <= this.#capacity) break;
      if (!active.has(key)) {
        this.#resident.delete(key);
        this.#drop(entry.value);
      }
    }
  }
  /** Tiles to draw, coarse first. Parent fallback remains behind a child until its fade completes. */
  drawTiles(now: number, fadeSeconds = 0.3): { resident: GeoTileResident<T>; opacity: number }[] {
    const drawn = new Map<string, { resident: GeoTileResident<T>; opacity: number }>();
    for (const tile of this.#selected) {
      const ancestors = geoTileAncestors(tile).reverse();
      let child = true;
      for (const a of ancestors) {
        const key = geoTileKey(a),
          resident = this.#resident.get(key);
        if (!resident) continue;
        const opacity =
          child && a.z === tile.z && fadeSeconds > 0
            ? Math.max(0, Math.min(1, (now - resident.loadedAt) / fadeSeconds))
            : 1;
        const prior = drawn.get(key);
        if (!prior || opacity > prior.opacity) drawn.set(key, { resident, opacity });
        if (opacity === 1) break;
        child = false;
      }
    }
    return [...drawn.values()].sort((a, b) => a.resident.tile.z - b.resident.tile.z);
  }
  /** Waits for current requests and queued successors; rejects the original load error. No silent retry. */
  async ready(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    const signal = AbortSignal.any([
      this.#lifetime.signal,
      ...(this.#external ? [this.#external] : []),
      ...(options.signal ? [options.signal] : []),
    ]);
    signal?.throwIfAborted();
    this.#external?.throwIfAborted();
    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
    });
    try {
      while (this.#pending.size)
        await Promise.race([Promise.all([...this.#pending.values()].map((p) => p.promise)), aborted]);
      this.#external?.throwIfAborted();
      if (this.#failed.size) throw this.error;
    } finally {
      if (abort) signal?.removeEventListener('abort', abort);
    }
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifetime.abort(new DOMException('Tile cache disposed; create a new cache', 'AbortError'));
    this.#external?.removeEventListener('abort', this.#abort);
    for (const p of this.#pending.values()) p.controller.abort();
    for (const r of this.#resident.values()) this.#drop(r.value);
    this.#resident.clear();
    this.#wanted = [];
    this.#selected = [];
    this.#failed.clear();
    this.#missing.clear();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
