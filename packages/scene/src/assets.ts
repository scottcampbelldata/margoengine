// Asset loading as data: a task queue (typed tasks with per-task success and error, progress, retry and an all-done
// event) and a registry (assets by key, swapped live, described in JSON, with a callback for the key nobody defined).
import { assetURL, checkRedirect } from '../../shared/asset-url.js';
import { fault, typeError } from '../../shared/errors.js';

const bad = (message: string): TypeError => typeError(message, 'arguments');

/** Where a task is. */
export type AssetTaskState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

/** What a task's `load` function is given. */
export interface AssetTaskContext {
  /** Aborted when the queue's run is aborted. Pass it to `fetch`. */
  signal: AbortSignal;
  /** Which attempt this is, from 1. */
  attempt: number;
  /** Reports this task's own progress, 0 to 1. */
  progress(fraction: number): void;
}

/** Options of {@link AssetQueue.add}. */
export interface AssetTaskOptions<T> {
  /** Extra attempts after a failure. Default: the queue's `retries`. */
  retries?: number;
  /** Share of the queue's overall progress. Default 1. */
  weight?: number;
  /** Called with the value as soon as this task succeeds. */
  onSuccess?(value: T, task: AssetTask<T>): void;
  /** Called with the error when this task has used its attempts. */
  onError?(error: unknown, task: AssetTask<T>): void;
}

/** One unit of work in an {@link AssetQueue}. */
export interface AssetTask<T = unknown> {
  readonly name: string;
  readonly state: AssetTaskState;
  /** The loaded value once `state` is `'done'`. */
  readonly value: T | undefined;
  /** The last error when `state` is `'failed'`. */
  readonly error: unknown;
  /** Attempts made so far. */
  readonly attempts: number;
  /** 0 to 1. */
  readonly progress: number;
}

/** Overall progress of a queue. */
export interface AssetQueueProgress {
  /** Weighted share finished, 0 to 1 (1 for an empty queue). */
  fraction: number;
  /** Tasks that ended, whether done, failed or cancelled. */
  finished: number;
  total: number;
  /** The task that just moved, when one did. */
  task?: AssetTask;
}

/** What `run` resolves with: every task, split by how it ended. */
export interface AssetQueueResult {
  done: AssetTask[];
  failed: AssetTask[];
  cancelled: AssetTask[];
  /** True when nothing failed or was cancelled. */
  ok: boolean;
}

/** Options of {@link AssetQueue}. */
export interface AssetQueueOptions {
  /** Tasks running at once. Default 4. */
  concurrency?: number;
  /** Extra attempts of a failing task. Default 0. */
  retries?: number;
  /** Milliseconds before attempt n + 1: `retryDelay * 2 ** (n - 1)`. Default 250. */
  retryDelay?: number;
  /** `fetch` for the `addText`, `addJSON`, `addBinary` and `addImage` helpers. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
}

type Events = {
  success: (task: AssetTask) => void;
  error: (task: AssetTask) => void;
  progress: (progress: AssetQueueProgress) => void;
  finish: (result: AssetQueueResult) => void;
};

interface Entry<T = unknown> extends AssetTask<T> {
  load(context: AssetTaskContext): Promise<T>;
  options: AssetTaskOptions<T>;
}

interface Mutable {
  state: AssetTaskState;
  value: unknown;
  error: unknown;
  attempts: number;
  progress: number;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', done);
      resolve();
    }, ms);
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * A queue of loading tasks. `add` a task, `run` the queue: tasks run `concurrency` at a time, a failing task is retried,
 * and `run` resolves when every task has ended, never rejecting for a task's failure. Events: `success` and `error` per
 * task, `progress` after each change, `finish` once. After a run, `retryFailed()` runs the failed tasks again.
 */
export class AssetQueue {
  private readonly entries: Entry[] = [];
  private readonly listeners: { [K in keyof Events]: Set<Events[K]> } = {
    success: new Set(),
    error: new Set(),
    progress: new Set(),
    finish: new Set(),
  };
  private readonly config: Required<Omit<AssetQueueOptions, 'fetch'>> & { fetch: typeof fetch | undefined };
  private running: Promise<AssetQueueResult> | undefined;

  constructor(options: AssetQueueOptions = {}) {
    const { concurrency = 4, retries = 0, retryDelay = 250 } = options;
    if (!Number.isInteger(concurrency) || concurrency < 1) throw bad(`AssetQueue concurrency ${concurrency} must be an integer of at least 1`);
    if (!Number.isInteger(retries) || retries < 0) throw bad(`AssetQueue retries ${retries} must be a non-negative integer`);
    if (!(retryDelay >= 0)) throw bad(`AssetQueue retryDelay ${retryDelay} must not be negative`);
    this.config = { concurrency, retries, retryDelay, fetch: options.fetch };
  }

  /** Every task, in the order added. */
  get tasks(): readonly AssetTask[] {
    return this.entries;
  }

  /** Subscribes to an event; returns the function that unsubscribes. */
  on<K extends keyof Events>(event: K, handler: Events[K]): () => void {
    this.listeners[event].add(handler);
    return () => void this.listeners[event].delete(handler);
  }

  /**
   * Adds a task. `load` returns the value; it may report `context.progress` and must pass `context.signal` to whatever
   * it waits on. Throws when a task with the same name exists, or while the queue runs.
   */
  add<T>(name: string, load: (context: AssetTaskContext) => Promise<T>, options: AssetTaskOptions<T> = {}): AssetTask<T> {
    if (typeof name !== 'string' || !name) throw bad('an asset task needs a non-empty name');
    if (typeof load !== 'function') throw bad(`asset task "${name}" needs a load function`);
    if (this.running) throw fault('state', `AssetQueue is running; add "${name}" before run() or after it finishes`);
    if (this.entries.some((e) => e.name === name)) throw fault('state', `an asset task named "${name}" exists; names must be unique`);
    const entry = { name, state: 'pending', value: undefined, error: undefined, attempts: 0, progress: 0, load, options } as Entry<T>;
    this.entries.push(entry as Entry);
    return entry;
  }

  private request(url: string, signal: AbortSignal): Promise<Response> {
    const f = this.config.fetch ?? globalThis.fetch;
    if (!f) throw fault('unsupported', 'AssetQueue needs fetch; pass options.fetch');
    return f(url, { signal }).then((response) => {
      if (!response.ok) throw fault('failed', `${url}: HTTP ${response.status}; check the URL`);
      return response;
    });
  }

  /** A task that fetches `url` as text. */
  addText(name: string, url: string, options?: AssetTaskOptions<string>): AssetTask<string> {
    return this.add(name, async ({ signal }) => (await this.request(url, signal)).text(), options);
  }

  /** A task that fetches `url` and parses it as JSON. */
  addJSON<T = unknown>(name: string, url: string, options?: AssetTaskOptions<T>): AssetTask<T> {
    return this.add(name, async ({ signal }) => (await this.request(url, signal)).json() as Promise<T>, options);
  }

  /** A task that fetches `url` as bytes, reporting progress from `Content-Length` when the server sends it. */
  addBinary(name: string, url: string, options?: AssetTaskOptions<Uint8Array>): AssetTask<Uint8Array> {
    return this.add(
      name,
      async ({ signal, progress }) => {
        const response = await this.request(url, signal),
          total = Number(response.headers.get('content-length')) || 0;
        if (!response.body || !total) return new Uint8Array(await response.arrayBuffer());
        const chunks: Uint8Array[] = [];
        let received = 0;
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          progress(Math.min(1, received / total));
        }
        const out = new Uint8Array(received);
        let at = 0;
        for (const chunk of chunks) (out.set(chunk, at), (at += chunk.length));
        return out;
      },
      options,
    );
  }

  /** A task that fetches `url` and decodes it as an image with `createImageBitmap`. */
  addImage(name: string, url: string, options?: AssetTaskOptions<ImageBitmap>): AssetTask<ImageBitmap> {
    return this.add(name, async ({ signal }) => createImageBitmap(await (await this.request(url, signal)).blob()), options);
  }

  private emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    for (const handler of [...this.listeners[event]]) (handler as (...a: unknown[]) => void)(...args);
  }

  private progressOf(task?: AssetTask): AssetQueueProgress {
    let weight = 0,
      got = 0,
      finished = 0;
    for (const e of this.entries) {
      const w = e.options.weight ?? 1;
      weight += w;
      const ended = e.state === 'done' || e.state === 'failed' || e.state === 'cancelled';
      got += w * (ended ? 1 : e.progress);
      if (ended) finished++;
    }
    return { fraction: weight ? got / weight : 1, finished, total: this.entries.length, ...(task ? { task } : {}) };
  }

  private async attempt(entry: Entry, signal: AbortSignal): Promise<void> {
    const m = entry as unknown as Mutable,
      retries = entry.options.retries ?? this.config.retries;
    m.state = 'running';
    for (;;) {
      m.attempts++;
      try {
        signal.throwIfAborted();
        const value = await entry.load({
          signal,
          attempt: m.attempts,
          progress: (f) => {
            m.progress = Math.min(1, Math.max(0, f));
            this.emit('progress', this.progressOf(entry));
          },
        });
        m.value = value;
        m.progress = 1;
        m.state = 'done';
        entry.options.onSuccess?.(value, entry);
        this.emit('success', entry);
        return;
      } catch (error) {
        if (signal.aborted) {
          m.state = 'cancelled';
          m.error = signal.reason;
          return;
        }
        m.error = error;
        if (m.attempts > retries) {
          m.state = 'failed';
          entry.options.onError?.(error, entry);
          this.emit('error', entry);
          return;
        }
        try {
          await sleep(this.config.retryDelay * 2 ** (m.attempts - 1), signal);
        } catch {
          m.state = 'cancelled';
          return;
        }
      }
    }
  }

  /**
   * Runs every pending task and resolves with how each ended; it never rejects for a task. Aborting `signal` cancels the
   * running and pending tasks (their state becomes `'cancelled'`). Calling `run` during a run returns that run.
   */
  run(signal?: AbortSignal): Promise<AssetQueueResult> {
    if (this.running) return this.running;
    const pending = this.entries.filter((e) => e.state === 'pending');
    const result = (async (): Promise<AssetQueueResult> => {
      const queue = [...pending];
      const worker = async (): Promise<void> => {
        for (let e = queue.shift(); e; e = queue.shift()) {
          if (signal?.aborted) {
            (e as unknown as Mutable).state = 'cancelled';
            continue;
          }
          await this.attempt(e, signal ?? new AbortController().signal);
          this.emit('progress', this.progressOf(e));
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.config.concurrency, pending.length) }, worker));
      const by = (s: AssetTaskState) => this.entries.filter((e) => e.state === s);
      const out: AssetQueueResult = { done: by('done'), failed: by('failed'), cancelled: by('cancelled'), ok: false };
      out.ok = !out.failed.length && !out.cancelled.length;
      this.emit('finish', out);
      return out;
    })().finally(() => {
      this.running = undefined;
    });
    this.running = result;
    return result;
  }

  /** Sets the failed (and cancelled) tasks back to pending and runs them again. */
  retryFailed(signal?: AbortSignal): Promise<AssetQueueResult> {
    if (this.running) throw fault('state', 'AssetQueue is running; wait for it before retryFailed()');
    for (const e of this.entries)
      if (e.state === 'failed' || e.state === 'cancelled') {
        const m = e as unknown as Mutable;
        (m.state = 'pending'), (m.error = undefined), (m.attempts = 0), (m.progress = 0);
      }
    return this.run(signal);
  }
}

// ---- the registry ---------------------------------------------------------------------------------------------------

/** How a registry loads one key: a URL it fetches, or a function that makes the value. */
export type AssetSource<T> = string | ((key: string, signal: AbortSignal) => Promise<T> | T);

/** One key in the JSON map of {@link AssetRegistry.fromJSON}: a URL, or a URL with the loader type. */
export type AssetMapEntry = string | { url: string; type?: string };

/** Options of {@link AssetRegistry}. */
export interface AssetRegistryOptions<T> {
  /**
   * Loads a URL. Default: fetch it and, by the entry's `type` (`'json'`, `'text'`, otherwise bytes), read it; the value
   * type `T` is then yours to promise.
   */
  loadURL?(url: string, type: string | undefined, signal: AbortSignal): Promise<T>;
  /** Custom fetch for the default URL loading and `loadMap`, the option the other Margo loaders take. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Called with a value that is replaced by `swap`, removed or disposed with the registry. */
  dispose?(value: T, key: string): void;
  /**
   * Called when `load(key)` finds no definition, or the definition fails. Return a replacement source (a URL or a
   * function) and the registry loads that instead, once; return nothing and `load` rejects.
   */
  onMissing?(key: string, reason: 'undefined' | 'failed', error?: unknown): AssetSource<T> | void | Promise<AssetSource<T> | void>;
}

/** Options of {@link AssetRegistry.loadMap}. */
export interface AssetMapOptions {
  signal?: AbortSignal;
  /** Custom fetch for a map given as a URL. Default the registry's `fetch`, else `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** URL prefixes entries may point to outside the map's directory, as in the glTF loaders. Default none. */
  allowedURLs?: readonly string[];
  /** What entries resolve against when the map is an object or a `File` (a URL map uses its own URL). Default none: entries must then be absolute and allowed. */
  baseURL?: string | URL;
  /** Largest map in bytes. Default 1 MiB. */
  maxBytes?: number;
}

const MAX_MAP_KEYS = 100_000;

function parseMap(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw typeError('the asset map is not valid JSON; check the file', 'arguments');
  }
}

/** Refuses a map that is not a plain object of `{key: url | {url, type}}`, naming the first bad entry. */
function checkMap(value: unknown): Record<string, string | { url: string; type?: string }> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw typeError('an asset map is a JSON object of {key: url | {url, type}}; check the file', 'arguments');
  const keys = Object.keys(value);
  if (keys.length > MAX_MAP_KEYS) throw fault('failed', `the asset map has ${keys.length} keys, more than ${MAX_MAP_KEYS}; split the map`);
  for (const key of keys) {
    const entry = (value as Record<string, unknown>)[key];
    if (!key || key.length > 1024 || key === '__proto__')
      throw typeError(`asset map key "${key.slice(0, 40)}" is not allowed; use a non-empty name up to 1024 characters`, 'arguments');
    const url = typeof entry === 'string' ? entry : (entry as { url?: unknown } | null)?.url,
      type = typeof entry === 'object' && entry !== null ? (entry as { type?: unknown }).type : undefined;
    if (typeof url !== 'string' || !url || (type !== undefined && (typeof type !== 'string' || type.length > 64)))
      throw typeError(`asset map entry "${key}" must be a URL string or {url, type} with string fields; check the file`, 'arguments');
  }
  return value as Record<string, string | { url: string; type?: string }>;
}

/** One key of an {@link AssetRegistry}; `refs` is kept by `AssetPool`. */
export interface AssetSlot<T> {
  source: AssetSource<T>;
  type?: string;
  version: number;
  value?: T;
  loading?: Promise<T>;
  controller?: AbortController;
  listeners: Set<(value: T, key: string) => void>;
  /** References held by `AssetPool`: acquire, preload groups and templates. */
  refs?: number;
}

/**
 * Assets by name. `define` a key with a URL or a function, `load` it (once: a second call shares the first), `swap` it
 * for another source and everyone `subscribe`d to the key gets the new value, and `fromJSON` fills the registry from a
 * `{key: url}` map. `onMissing` is the one place that decides what an unknown or broken key becomes.
 */
export class AssetRegistry<T = unknown> {
  protected readonly slots = new Map<string, AssetSlot<T>>();
  protected disposed = false;

  constructor(protected readonly options: AssetRegistryOptions<T> = {}) {}

  /** The defined keys, in order. */
  get keys(): string[] {
    return [...this.slots.keys()];
  }

  has(key: string): boolean {
    return this.slots.has(key);
  }

  /** The loaded value of a key, or undefined when it is unknown or not loaded. */
  get(key: string): T | undefined {
    return this.slots.get(key)?.value;
  }

  /** Defines a key. Throws when it exists: use `swap` to change it. */
  define(key: string, source: AssetSource<T>, type?: string): this {
    this.live();
    if (typeof key !== 'string' || !key) throw bad('an asset key must be a non-empty string');
    if (this.slots.has(key)) throw fault('state', `asset "${key}" is already defined; use swap() to replace it`);
    this.slots.set(key, { source, type, version: 0, listeners: new Set() });
    return this;
  }

  /** Defines every key of a `{key: url | {url, type}}` map; keys already defined are swapped, not rejected. */
  fromJSON(map: Record<string, AssetMapEntry>): this {
    for (const [key, entry] of Object.entries(map)) {
      const url = typeof entry === 'string' ? entry : entry?.url,
        type = typeof entry === 'string' ? undefined : entry?.type;
      if (typeof url !== 'string') throw bad(`asset map entry "${key}" needs a URL string or {url, type}`);
      if (this.slots.has(key)) this.swapSource(key, url, type);
      else this.define(key, url, type);
    }
    return this;
  }

  /** The URL definitions as a map, for saving. Function sources are left out. */
  toJSON(): Record<string, AssetMapEntry> {
    const out: Record<string, AssetMapEntry> = {};
    for (const [key, slot] of this.slots)
      if (typeof slot.source === 'string') out[key] = slot.type ? { url: slot.source, type: slot.type } : slot.source;
    return out;
  }

  /** Calls `callback` with the value of `key` after every load and swap. Returns the function that stops it. */
  subscribe(key: string, callback: (value: T, key: string) => void): () => void {
    const slot = this.slots.get(key);
    if (!slot) throw fault('state', `asset "${key}" is not defined; define() it before subscribe()`);
    slot.listeners.add(callback);
    if (slot.value !== undefined) callback(slot.value, key);
    return () => void slot.listeners.delete(callback);
  }

  protected live(): void {
    if (this.disposed) throw fault('disposed', 'the AssetRegistry is disposed');
  }

  private async fetchValue(key: string, source: AssetSource<T>, type: string | undefined, signal: AbortSignal): Promise<T> {
    if (typeof source === 'function') return source(key, signal);
    if (this.options.loadURL) return this.options.loadURL(source, type, signal);
    const response = await (this.options.fetch ?? fetch)(source, { signal });
    if (!response.ok) throw fault('failed', `${source}: HTTP ${response.status}; check the URL`);
    return (type === 'json' ? response.json() : type === 'text' ? response.text() : new Uint8Array(await response.arrayBuffer())) as T;
  }

  private publish(slot: AssetSlot<T>, key: string, value: T): void {
    const old = slot.value;
    slot.value = value;
    if (old !== undefined && old !== value) this.options.dispose?.(old, key);
    for (const callback of [...slot.listeners]) callback(value, key);
  }

  /**
   * Loads a key (shared with a load in flight) and resolves with its value. An unknown key, or a failing one, goes to
   * `onMissing` once; without a replacement `load` rejects. `signal` aborts this key's load.
   */
  async load(key: string, signal?: AbortSignal): Promise<T> {
    this.live();
    let slot = this.slots.get(key);
    if (!slot) {
      const replacement = await this.options.onMissing?.(key, 'undefined');
      if (replacement === undefined || replacement === null) throw fault('state', `asset "${key}" is not defined; define() it or handle it in onMissing`);
      this.define(key, replacement);
      slot = this.slots.get(key)!;
    }
    if (slot.value !== undefined) return slot.value;
    if (slot.loading) return slot.loading;
    const s = slot,
      version = s.version,
      controller = new AbortController();
    s.controller = controller;
    signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    const attempt = async (source: AssetSource<T>, type: string | undefined, retried: boolean): Promise<T> => {
      try {
        const value = await this.fetchValue(key, source, type, controller.signal);
        if (s.version !== version) return (await s.loading) as T; // swapped while loading: the swap's value wins
        this.publish(s, key, value);
        return value;
      } catch (error) {
        if (controller.signal.aborted || s.version !== version) throw controller.signal.aborted ? controller.signal.reason : error;
        const replacement = retried ? undefined : await this.options.onMissing?.(key, 'failed', error);
        if (replacement === undefined || replacement === null) throw error;
        return attempt(replacement, undefined, true);
      }
    };
    s.loading = attempt(s.source, s.type, false).finally(() => {
      if (s.version === version) s.loading = undefined;
    });
    return s.loading;
  }

  private swapSource(key: string, source: AssetSource<T>, type?: string): AssetSlot<T> {
    const slot = this.slots.get(key)!;
    slot.controller?.abort(new Error(`asset "${key}" was swapped`));
    slot.version++;
    slot.source = source;
    slot.type = type;
    slot.loading = undefined;
    return slot;
  }

  /**
   * Replaces what a key is made of. A load in flight is cancelled; if the key was loaded (or anyone is subscribed) the
   * new source loads now, `dispose` gets the old value and the subscribers get the new one. Resolves with the new value,
   * or undefined when nothing needed loading yet.
   */
  async swap(key: string, source: AssetSource<T>, type?: string): Promise<T | undefined> {
    this.live();
    if (!this.slots.has(key)) throw fault('state', `asset "${key}" is not defined; define() it before swap()`);
    const slot = this.swapSource(key, source, type),
      wanted = slot.value !== undefined || slot.listeners.size > 0;
    if (!wanted) return undefined;
    const controller = new AbortController(),
      version = slot.version;
    slot.controller = controller;
    const value = await this.fetchValue(key, source, type, controller.signal);
    if (slot.version !== version) return slot.value;
    this.publish(slot, key, value);
    return value;
  }

  /**
   * Fills the registry from a JSON asset map given as an object, a URL (fetched), or a `File`/`Blob`. Resolves with the
   * keys it defined or swapped. Without a `fetch`, a URL map needs the global one.
   */
  async loadMap(source: string | Blob | Record<string, AssetMapEntry>, options: AssetMapOptions = {}): Promise<string[]> {
    this.live();
    const { signal, allowedURLs = [], maxBytes = 1 << 20 } = options;
    let map: unknown = source,
      base: string | URL | undefined = options.baseURL;
    if (typeof source === 'string') {
      // The map's own URL is the base its entries resolve against, as a glTF's URI do against the file.
      const mapURL = new URL(source, base);
      base = mapURL;
      const response = checkRedirect(await (options.fetch ?? this.options.fetch ?? fetch)(mapURL.href, { signal }), mapURL, allowedURLs, 'Asset map');
      if (!response.ok) throw fault('failed', `${mapURL.href}: HTTP ${response.status}; check the asset map URL`);
      const text = await response.text();
      if (text.length > maxBytes) throw fault('failed', `the asset map is larger than ${maxBytes} bytes; raise maxBytes or split the map`);
      map = parseMap(text);
    } else if (typeof Blob !== 'undefined' && source instanceof Blob) {
      if (source.size > maxBytes) throw fault('failed', `the asset map is larger than ${maxBytes} bytes; raise maxBytes or split the map`);
      map = parseMap(await source.text());
    }
    const checked = checkMap(map);
    const resolved: Record<string, AssetMapEntry> = {};
    for (const [key, entry] of Object.entries(checked)) {
      const url = typeof entry === 'string' ? entry : entry.url,
        // data: URIs carry their bytes and name no host; everything else must stay inside the map's directory (or allowedURLs).
        absolute = /^data:/i.test(url) ? url : assetURL(url, base, allowedURLs, `Asset "${key}"`).href;
      resolved[key] = typeof entry === 'string' ? absolute : { ...entry, url: absolute };
    }
    this.fromJSON(resolved);
    return Object.keys(resolved);
  }

  /** Disposes the loaded value of a key but keeps its definition, so the next `load` fetches it again. Returns false for an unknown key. */
  unload(key: string): boolean {
    const slot = this.slots.get(key);
    if (!slot) return false;
    slot.controller?.abort(new Error(`asset "${key}" was unloaded`));
    slot.version++;
    slot.loading = undefined;
    if (slot.value !== undefined) this.options.dispose?.(slot.value, key);
    slot.value = undefined;
    return true;
  }

  /** Loads a key again from its source: the new value replaces the old one (disposed) and subscribers get it. */
  async reload(key: string, signal?: AbortSignal): Promise<T> {
    const slot = this.slots.get(key);
    if (!slot) throw fault('state', `asset "${key}" is not defined; define() it before reload()`);
    const old = slot.value;
    slot.controller?.abort(new Error(`asset "${key}" was reloaded`));
    slot.version++;
    slot.loading = undefined;
    slot.value = undefined;
    const value = await this.load(key, signal);
    if (old !== undefined && old !== value) this.options.dispose?.(old, key);
    return value;
  }

  /** Removes a key, disposing its value and cancelling its load. */
  remove(key: string): boolean {
    const slot = this.slots.get(key);
    if (!slot) return false;
    slot.controller?.abort(new Error(`asset "${key}" was removed`));
    slot.version++;
    if (slot.value !== undefined) this.options.dispose?.(slot.value, key);
    slot.listeners.clear();
    return this.slots.delete(key);
  }

  /** Removes every key. The registry cannot be used afterwards. */
  dispose(): void {
    if (this.disposed) return;
    for (const key of this.keys) this.remove(key);
    this.disposed = true;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
