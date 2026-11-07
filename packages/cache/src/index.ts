/// <reference lib="esnext.disposable" preserve="true" />
/** Options for `new AssetCache(...)`. A negative or NaN `maxBytes` or `timeout` throws a RangeError. */
export interface AssetCacheOptions {
  /** IndexedDB database name, one per app or asset set. Default `'margo-assets'`. */
  name?: string;
  /** App or content version. Opening with a different value deletes every stored file. Default `''`. */
  version?: string | number;
  /** Byte budget; the least recently used files are evicted beyond it. Default 512 MiB. */
  maxBytes?: number;
  /** Ask the browser not to evict this origin's storage (`navigator.storage.persist()`, main thread only). Default false. */
  persist?: boolean;
  /** A stale file is served from the cache when revalidating takes longer than this (ms). Default 5000. */
  timeout?: number;
  /** Network fetch underneath, for example one that adds credentials. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Which stored entry a request maps to, for content that differs by request: `varyKeys()` of `@margoengine/cache/vary`. Default: the URL. */
  keys?: AssetCacheKeys;
  /** How eviction finds the least recently used files: `evictionIndex()` of `@margoengine/cache/eviction`. Default: read every entry's metadata before each write. */
  eviction?: AssetCacheEviction;
}
/** A stored file's record, as AssetCache writes it in its `meta` store. */
export interface AssetCacheEntry {
  /** Its key: the URL, or what `keys` chose. */
  url: string;
  /** Bytes. */
  size: number;
  /** Last use, ms since the epoch. */
  used: number;
}
/**
 * Bookkeeping for eviction kept inside AssetCache's own transactions. `@margoengine/cache/eviction` provides one that keeps
 * an index on last use and a running byte total, so a write reads only the files it evicts.
 */
export interface AssetCacheEviction {
  /** The IndexedDB version the database needs, above 1; a database at a higher version opens with it too. */
  readonly version: number;
  /** Adds what it needs during an upgrade from `oldVersion` (0 for a new database). */
  upgrade(meta: IDBObjectStore, oldVersion: number): void;
  /**
   * In a readwrite transaction: evicts least recently used entries (never `entry.url`) until the stored bytes plus
   * `entry` fit `limit` (with `squeeze`, also at most the bytes of the other entries), writes `entry` and `blob`, and
   * calls `done` with the number evicted.
   */
  write(
    meta: IDBObjectStore,
    data: IDBObjectStore,
    entry: AssetCacheEntry,
    blob: Blob,
    limit: number,
    squeeze: boolean,
    done: (evicted: number) => void,
  ): void;
  /** In a readwrite transaction: removes one key from both stores. */
  remove(meta: IDBObjectStore, data: IDBObjectStore, key: IDBValidKey): void;
  /** In a readonly transaction: calls `done` with the stored bytes and files. */
  usage(meta: IDBObjectStore, done: (bytes: number, files: number) => void): void;
}
/**
 * Maps requests to stored entries. Every key is the URL, or the URL, a newline and more, so `delete(url)` removes them
 * all. `varyKeys()` of `@margoengine/cache/vary` is one that honours `Vary` and credentials.
 */
export interface AssetCacheKeys {
  /** The key to look up; `read(key)` reads a stored record. Undefined: the request goes to the network uncached. */
  lookup(request: Request, url: string, read: (key: string) => Promise<unknown>): Promise<string | undefined>;
  /** The key to store a 200 response under, with records to write beside it. Undefined: it is not stored. */
  store(
    request: Request,
    url: string,
    response: Response,
  ): Promise<{ key: string; records?: [string, unknown][] } | undefined>;
}
/** Counts since construction. `hits` includes `revalidated` and `offline`. */
export interface AssetCacheStats {
  hits: number;
  revalidated: number;
  offline: number;
  misses: number;
  stored: number;
  evicted: number;
  errors: number;
}
/** Result of `AssetCache.usage()`. */
export interface AssetCacheUsage {
  /** Total size of the cached files in bytes. */
  bytes: number;
  /** Number of cached files. */
  files: number;
  /** Origin storage quota in bytes from `navigator.storage.estimate()`, when available. */
  quota?: number;
  /** Origin storage used in bytes from `navigator.storage.estimate()`, when available. */
  usage?: number;
}
interface Entry {
  url: string;
  size: number;
  type: string;
  etag: string | null;
  modified: string | null;
  fresh: number;
  used: number;
  final: string;
}

const M = 'meta',
  D = 'data',
  VERSION = '\0version';
const isEntry = (value: unknown): value is Entry => typeof (value as Entry | null)?.size === 'number';

/**
 * IndexedDB cache for large assets (GLB, .bin, textures, STEP) behind a fetch-compatible `cache.fetch`, which every
 * loader takes as its `fetch` option. Works in windows, Web Workers and service workers. Stored files are revalidated
 * with ETag / Last-Modified once per AssetCache (unless `Cache-Control: max-age` still holds) and served from the cache
 * when offline, timed out or failing. Range requests are served from the cached whole file; a range miss goes to the
 * network and fills the cache with the whole file in the background. Any storage failure (private mode, quota) falls
 * through to the network.
 */
export class AssetCache {
  readonly stats: AssetCacheStats = {
    hits: 0,
    revalidated: 0,
    offline: 0,
    misses: 0,
    stored: 0,
    evicted: 0,
    errors: 0,
  };
  readonly maxBytes: number;
  readonly timeout: number;
  private db: Promise<IDBDatabase | null>;
  private network: typeof globalThis.fetch;
  private keys?: AssetCacheKeys;
  private eviction?: AssetCacheEviction;
  private checked = new Set<string>();
  private pending = new Set<Promise<unknown>>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor({
    name = 'margo-assets',
    version = '',
    maxBytes = 512 * 2 ** 20,
    persist = false,
    timeout = 5000,
    fetch,
    keys,
    eviction,
  }: AssetCacheOptions = {}) {
    if (!(maxBytes >= 0) || !(timeout >= 0))
      throw new RangeError('AssetCache maxBytes and timeout must be non-negative');
    this.maxBytes = maxBytes;
    this.timeout = timeout;
    this.network = fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.keys = keys;
    this.eviction = eviction;
    if (persist) globalThis.navigator?.storage?.persist?.().catch(() => {});
    this.db = this.open(name, String(version)).catch(() => null);
  }

  private async open(name: string, version: string): Promise<IDBDatabase> {
    const request = indexedDB.open(name, this.eviction?.version ?? 1);
    request.onupgradeneeded = (event) => {
      if (event.oldVersion < 1) {
        request.result.createObjectStore(M);
        request.result.createObjectStore(D);
      }
      this.eviction?.upgrade(request.transaction!.objectStore(M), event.oldVersion);
    };
    const db = await new Promise<IDBDatabase>((ok, no) => {
      request.onsuccess = () => ok(request.result);
      request.onerror = () => no(request.error);
    });
    db.onversionchange = () => db.close();
    try {
      await this.tx(
        'readwrite',
        (meta, data) => {
          const stored = meta.get(VERSION);
          stored.onsuccess = () => {
            if (stored.result !== version) {
              meta.clear();
              data.clear();
              meta.put(version, VERSION);
            }
          };
        },
        db,
      );
    } catch (error) {
      db.close();
      throw error;
    }
    return db;
  }

  /** Runs body in one transaction over both stores; false when IndexedDB is unavailable. */
  private async tx(
    mode: IDBTransactionMode,
    body: (meta: IDBObjectStore, data: IDBObjectStore) => void,
    db?: IDBDatabase | null,
  ): Promise<boolean> {
    db ??= await this.db;
    if (!db) return false;
    const t = db.transaction([M, D], mode);
    body(t.objectStore(M), t.objectStore(D));
    await new Promise<void>((ok, no) => {
      t.oncomplete = () => ok();
      t.onerror = t.onabort = () => no(t.error ?? new DOMException('Transaction aborted', 'AbortError'));
    });
    return true;
  }

  private track<T>(work: Promise<T>): Promise<T> {
    const done = work.finally(() => this.pending.delete(done));
    this.pending.add(done);
    return done;
  }

  /** Fetch-compatible: pass it as a loader's `fetch` option. GET over HTTP(S) is cached; anything else goes to the network. */
  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init),
      url = request.url.replace(/#.*/, ''),
      range = request.headers.get('range');
    if (request.method !== 'GET' || !/^https?:/i.test(url)) return this.network(request);
    const key = this.keys ? await this.keys.lookup(request, url, (k) => this.read(k)) : url;
    if (key === undefined) return this.network(request);
    const hit = await this.lookup(key);
    if (!hit) {
      if (range) {
        this.fill(request, key);
        return this.network(request);
      }
      const response = await this.network(request);
      this.stats.misses++;
      return this.keep(request, key, response, null);
    }
    const [entry, blob] = hit,
      fresh = entry.fresh > Date.now() || this.checked.has(key);
    if (fresh || globalThis.navigator?.onLine === false)
      return this.serve(entry, blob, range, fresh ? undefined : 'offline');
    request.signal.throwIfAborted();
    this.checked.add(key);
    const headers = new Headers(request.headers),
      controller = new AbortController(),
      abort = () => controller.abort(request.signal.reason);
    headers.delete('range');
    if (entry.etag) headers.set('if-none-match', entry.etag);
    if (entry.modified) headers.set('if-modified-since', entry.modified);
    request.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeout);
    let response: Response;
    try {
      response = await this.network(new Request(request, { headers, signal: controller.signal }));
    } catch (error) {
      if (request.signal.aborted) throw error;
      return this.serve(entry, blob, range, 'offline');
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 304) {
      const age = /max-age=(\d+)/i.exec(response.headers.get('cache-control') ?? '');
      if (age) entry.fresh = Date.now() + +age[1] * 1e3;
      return this.serve(entry, blob, range, 'revalidated');
    }
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      return this.serve(entry, blob, range, 'offline');
    }
    this.stats.misses++;
    // A changed file that fails mid-download (Wi-Fi drop) still leaves the stored copy.
    try {
      return await this.keep(request, key, response, range);
    } catch (error) {
      if (request.signal.aborted) throw error;
      return this.serve(entry, blob, range, 'offline');
    }
  };

  private async read(key: string): Promise<unknown> {
    let found: IDBRequest | undefined;
    await this.tx('readonly', (meta) => {
      found = meta.get(key);
    }).catch(() => {
      this.stats.errors++;
    });
    return found?.result;
  }

  private async lookup(url: string): Promise<[Entry, Blob] | undefined> {
    let entry: IDBRequest | undefined, data: IDBRequest | undefined;
    try {
      await this.tx('readonly', (meta, store) => {
        entry = meta.get(url);
        data = store.get(url);
      });
    } catch {
      this.stats.errors++;
      return;
    }
    return isEntry(entry?.result) && data?.result ? [entry.result, data.result] : undefined;
  }

  private serve(entry: Entry, blob: Blob, range: string | null, reason?: 'revalidated' | 'offline'): Response {
    this.stats.hits++;
    if (reason) this.stats[reason]++;
    entry.used = Date.now();
    this.queue(() => this.tx('readwrite', (meta) => meta.put(entry, entry.url)));
    return this.respond(entry, blob, range);
  }

  private respond(entry: Entry, blob: Blob, range: string | null): Response {
    const size = blob.size,
      headers: Record<string, string> = { 'content-type': entry.type },
      match = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (entry.etag) headers.etag = entry.etag;
    if (entry.modified) headers['last-modified'] = entry.modified;
    let body = blob,
      status = 200;
    if (match && (match[1] || match[2])) {
      const start = match[1] ? +match[1] : Math.max(0, size - +match[2]),
        end = match[1] && match[2] ? Math.min(+match[2], size - 1) : size - 1;
      if (start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
      body = blob.slice(start, end + 1);
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['content-length'] = String(body.size);
    const response = new Response(body, { status, headers });
    Object.defineProperty(response, 'url', { value: entry.final });
    return response;
  }

  /** Stores a 200 response (unless `Cache-Control: no-store`) in the background and answers from its bytes. */
  private async keep(request: Request, key: string, response: Response, range: string | null): Promise<Response> {
    const control = response.headers.get('cache-control') ?? '',
      age = /max-age=(\d+)/i.exec(control);
    if (response.status !== 200 || /no-store/i.test(control)) return response;
    const url = key.replace(/\n[^]*/, ''),
      target = this.keys ? await this.keys.store(request, url, response) : { key },
      blob = await response.blob(),
      now = Date.now();
    const entry: Entry = {
      url: target?.key ?? key,
      size: blob.size,
      type: response.headers.get('content-type') ?? '',
      etag: response.headers.get('etag'),
      modified: response.headers.get('last-modified'),
      fresh: age && !/no-cache/i.test(control) ? now + +age[1] * 1e3 : 0,
      used: now,
      final: response.url || url,
    };
    this.checked.add(entry.url);
    if (target && entry.size <= this.maxBytes) this.queue(() => this.put(entry, blob, target.records));
    return this.respond(entry, blob, range);
  }

  /** Downloads the whole file of a range miss in the background, with the request's own headers. */
  private fill(request: Request, key: string): void {
    if (this.checked.has(key)) return;
    this.checked.add(key);
    const headers = new Headers(request.headers);
    headers.delete('range');
    const whole = new Request(request.url, { headers, credentials: request.credentials });
    this.track(
      this.network(whole)
        .then((response) => {
          this.stats.misses++;
          return this.keep(whole, key, response, null);
        })
        .catch(() => {
          this.checked.delete(key);
        }),
    );
  }

  /** Writes run one at a time so eviction sees every earlier write. */
  private queue(work: () => Promise<unknown>): void {
    this.track(
      (this.writes = this.writes.then(work).catch(() => {
        this.stats.errors++;
      })),
    );
  }

  private async put(entry: Entry, blob: Blob, records: [string, unknown][] = []): Promise<void> {
    const eviction = this.eviction;
    if (eviction) {
      const write = async (squeeze: boolean) => {
        let evicted = 0;
        if (
          await this.tx('readwrite', (meta, data) => {
            for (const [key, value] of records) meta.put(value, key);
            eviction.write(meta, data, entry, blob, this.maxBytes, squeeze, (n) => {
              evicted = n;
            });
          })
        ) {
          this.stats.stored++;
          this.stats.evicted += evicted;
        }
      };
      try {
        return await write(false);
      } catch (error) {
        if ((error as Error)?.name !== 'QuotaExceededError') throw error;
        return await write(true);
      }
    }
    let all: IDBRequest | undefined;
    await this.tx('readonly', (meta) => {
      all = meta.getAll();
    });
    const others = ((all?.result ?? []) as unknown[])
      .filter(isEntry)
      .filter((e) => e.url !== entry.url)
      .sort((a, b) => a.used - b.used);
    const write = async (limit: number) => {
      const evict: string[] = [];
      for (
        let total = others.reduce((sum, e) => sum + e.size, entry.size), i = 0;
        total > limit && i < others.length;
        i++
      ) {
        total -= others[i].size;
        evict.push(others[i].url);
      }
      if (
        await this.tx('readwrite', (meta, data) => {
          for (const url of evict) {
            meta.delete(url);
            data.delete(url);
          }
          data.put(blob, entry.url);
          meta.put(entry, entry.url);
          for (const [key, value] of records) meta.put(value, key);
        })
      ) {
        this.stats.stored++;
        this.stats.evicted += evict.length;
      }
    };
    // Over the browser's quota: evict as many bytes as the new file needs (on top of the budget) and try once more.
    try {
      await write(this.maxBytes);
    } catch (error) {
      if ((error as Error)?.name !== 'QuotaExceededError') throw error;
      await write(
        Math.min(
          this.maxBytes,
          others.reduce((sum, e) => sum + e.size, 0),
        ),
      );
    }
  }

  /** Resolves when every background download and write started so far has finished. */
  async flush(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** Bytes and files stored here, plus the origin's `navigator.storage.estimate()` where available. */
  async usage(): Promise<AssetCacheUsage> {
    let all: IDBRequest | undefined,
      bytes = 0,
      files = 0;
    await this.tx('readonly', (meta) => {
      if (this.eviction)
        this.eviction.usage(meta, (b, f) => {
          bytes = b;
          files = f;
        });
      else all = meta.getAll();
    }).catch(() => {
      this.stats.errors++;
    });
    const entries = ((all?.result ?? []) as unknown[]).filter(isEntry),
      estimate = await globalThis.navigator?.storage?.estimate?.().catch(() => undefined);
    return {
      bytes: entries.reduce((sum, e) => sum + e.size, bytes),
      files: entries.length + files,
      quota: estimate?.quota,
      usage: estimate?.usage,
    };
  }

  /** Removes one URL (resolved against the page), with every entry `keys` stored for it. */
  async delete(url: string | URL): Promise<void> {
    const key = new URL(url, globalThis.location?.href).href.replace(/#.*/, ''),
      mine = (k: unknown) => k === key || String(k).startsWith(`${key}\n`);
    for (const k of this.checked) if (mine(k)) this.checked.delete(k);
    await this.tx('readwrite', (meta, data) => {
      meta.getAllKeys().onsuccess = (event) => {
        for (const k of (event.target as IDBRequest<IDBValidKey[]>).result)
          if (mine(k) && this.eviction) this.eviction.remove(meta, data, k);
          else if (mine(k)) {
            meta.delete(k);
            data.delete(k);
          }
      };
    });
  }

  /** Removes every stored file (the version is kept). */
  async clear(): Promise<void> {
    this.checked.clear();
    await this.tx('readwrite', (meta, data) => {
      data.clear();
      meta.getAllKeys().onsuccess = (event) => {
        for (const key of (event.target as IDBRequest<IDBValidKey[]>).result) if (key !== VERSION) meta.delete(key);
      };
    });
  }

  /** Closes the database after pending writes; `fetch` then goes straight to the network. */
  dispose(): void {
    void this.flush()
      .then(() => {
        const db = this.db;
        this.db = Promise.resolve(null);
        return db;
      })
      .then((db) => db?.close());
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

let shared: AssetCache | undefined;
/** `fetch` through a shared default AssetCache (`name: 'margo-assets'`, no version). Create your own AssetCache to set a version. */
export const cachedFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
  (shared ??= new AssetCache()).fetch(input, init);
