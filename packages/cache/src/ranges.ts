/// <reference lib="esnext.disposable" preserve="true" />
import { byteRange, contentRange, defaultFetch, freshnessPolicy, ifRange, transact } from './http.js';

/** Options for `new RangeCache(...)`. A negative or NaN `maxBytes` or `timeout`, or a `block` under 1, throws a RangeError. */
export interface RangeCacheOptions {
  /** IndexedDB database name; keep it apart from an AssetCache's. Default `'margo-ranges'`. */
  name?: string;
  /** App or content version. Opening with a different value deletes every stored block. Default `''`. */
  version?: string | number;
  /** Byte budget over all files; the least recently used files are evicted beyond it. Default 512 MiB. */
  maxBytes?: number;
  /** Block size in bytes: ranges are fetched and stored in whole aligned blocks. Default 65,536 (64 KiB). */
  block?: number;
  /** Stored blocks are served when revalidating takes longer than this (ms). Default 5000. */
  timeout?: number;
  /** Network fetch underneath. Default `globalThis.fetch` as it is at construction, so setting `globalThis.fetch` to this one later is safe. */
  fetch?: typeof fetch;
}
/** Counts since construction. `hits` includes `revalidated` and `offline`. */
export interface RangeCacheStats {
  /** Requests answered from stored blocks alone. */
  hits: number;
  /** Hits after a conditional request (304, or the same validators) confirmed the stored blocks. */
  revalidated: number;
  /** Hits served without confirming the blocks: offline, timed out or failing. */
  offline: number;
  /** Requests that needed some blocks from the network and found others stored. */
  partial: number;
  /** Requests whose blocks all came from the network. */
  misses: number;
  /** Writes of new blocks. */
  stored: number;
  /** Files evicted for the byte budget or the browser's quota. */
  evicted: number;
  /** Storage reads or writes that failed. */
  errors: number;
}
/** Result of `RangeCache.usage()`. */
export interface RangeCacheUsage {
  /** Bytes in stored blocks. */
  bytes: number;
  /** Files with at least one stored block. */
  files: number;
  /** Stored blocks. */
  blocks: number;
}
interface Stored {
  url: string;
  size: number;
  type: string;
  etag: string | null;
  modified: string | null;
  final: string;
  fresh: number;
  control?: string;
  expires?: string | null;
  used: number;
  /** Stored block indices, ascending. */
  blocks: number[];
  /** Bytes of the stored blocks. */
  bytes: number;
}

const M = 'meta',
  D = 'data',
  VERSION = '\0version';
const isStored = (value: unknown): value is Stored => Array.isArray((value as Stored | null)?.blocks);
const key = (url: string, block: number) => `${url}\n${block}`;
/** Thrown inside a fetch when the server's validators or size differ from the stored file's. */
const CHANGED = Symbol('changed');

/**
 * Block cache for HTTP range requests, so files read in pieces (progressive glTF streaming, KTX2 streaming, LAS and
 * COPC point clouds) also load offline and from disk. Each file is kept as aligned blocks in IndexedDB; a request is
 * answered 206 from the stored blocks it covers, and only the missing blocks go to the network, as whole-block ranges.
 * Stored blocks are revalidated with ETag / Last-Modified once per RangeCache unless `Cache-Control: max-age` holds; a
 * changed file (other validators or size) drops every stored block of it. Offline, timed out or failing, a request whose
 * blocks are all stored is still answered; one that needs a missing block fails as the network does. A request without
 * `Range` is answered 200 from the blocks when all are stored, and a 200 download is stored as blocks. Any storage
 * failure falls through to the network.
 */
export class RangeCache {
  readonly stats: RangeCacheStats = {
    hits: 0,
    revalidated: 0,
    offline: 0,
    partial: 0,
    misses: 0,
    stored: 0,
    evicted: 0,
    errors: 0,
  };
  readonly maxBytes: number;
  readonly block: number;
  readonly timeout: number;
  private db: Promise<IDBDatabase | null>;
  private network: typeof globalThis.fetch;
  private checked = new Set<string>();
  private pending = new Set<Promise<unknown>>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor({
    name = 'margo-ranges',
    version = '',
    maxBytes = 512 * 2 ** 20,
    block = 65536,
    timeout = 5000,
    fetch,
  }: RangeCacheOptions = {}) {
    if (!(maxBytes >= 0) || !(timeout >= 0) || !(block >= 1) || !Number.isInteger(block))
      throw new RangeError('RangeCache maxBytes and timeout must be non-negative and block a positive integer');
    this.maxBytes = maxBytes;
    this.block = block;
    this.timeout = timeout;
    this.network = fetch ?? defaultFetch();
    this.db = this.open(name, `${version}\n${block}`).catch(() => null);
  }

  private async open(name: string, version: string): Promise<IDBDatabase> {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(M);
      request.result.createObjectStore(D);
    };
    const db = await new Promise<IDBDatabase>((ok, no) => {
      request.onsuccess = () => ok(request.result);
      request.onerror = () => no(request.error);
    });
    db.onversionchange = () => db.close();
    try {
      // A new version or block size drops every block: blocks of another size cannot be reused.
      await transact(db, [M, D], 'readwrite', (meta, data) => {
        const stored = meta.get(VERSION);
        stored.onsuccess = () => {
          if (stored.result !== version) {
            meta.clear();
            data.clear();
            meta.put(version, VERSION);
          }
        };
      });
    } catch (error) {
      db.close();
      throw error;
    }
    return db;
  }

  private track<T>(work: Promise<T>): Promise<T> {
    const done = work.finally(() => this.pending.delete(done));
    this.pending.add(done);
    return done;
  }

  /** Writes run one at a time so eviction sees every earlier write. */
  private queue(work: (db: IDBDatabase) => Promise<unknown>): void {
    this.track(
      (this.writes = this.writes
        .then(() => this.db)
        .then((db) => db && work(db))
        .catch(() => {
          this.stats.errors++;
        })),
    );
  }

  /** Fetch-compatible: pass it as a loader's `fetch` option, or answer a service worker's fetch event with it. */
  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init),
      url = request.url.replace(/#.*/, '');
    if (request.method !== 'GET' || !/^https?:/i.test(url)) return this.network(request);
    try {
      return await this.answer(request, url);
    } catch (error) {
      if (error !== CHANGED) throw error;
      // The file changed on the server: its blocks are dropped, so this asks again as a miss.
      return this.answer(request, url);
    }
  };

  private async answer(request: Request, url: string): Promise<Response> {
    // Fetch rejects at once on a signal that is already aborted, stored blocks included.
    request.signal.throwIfAborted();
    const header = request.headers.get('range'),
      file = await this.record(url);
    if (!file) return this.miss(request, url, header);
    // RFC 9110 section 13.1.5: an If-Range that does not name the stored file is the server's to answer.
    if (header && !ifRange(request.headers.get('if-range'), file.etag, file.modified)) return this.network(request);
    const range = header ? byteRange(header, file.size) : ([0, file.size - 1] as [number, number]);
    if (range === 'unsatisfiable')
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${file.size}` } });
    // A multi-range request goes to the network unchanged.
    if (!range) return this.network(request);
    const [start, end] = range,
      first = Math.floor(start / this.block),
      last = Math.floor(end / this.block),
      have = new Set(file.blocks),
      missing: number[] = [];
    for (let i = first; i <= last; i++) if (!have.has(i)) missing.push(i);
    let fetched = new Map<number, Blob>();
    if (missing.length) {
      const got = await this.download(request, file, missing);
      if (got instanceof Response) return got;
      fetched = got;
      this.stats[missing.length === last - first + 1 ? 'misses' : 'partial']++;
    } else {
      let reason: 'revalidated' | 'offline' | undefined;
      if (!this.checked.has(url) && file.fresh <= Date.now()) {
        // Once per RangeCache, as AssetCache: a failed check is not retried on every range of a streaming file.
        this.checked.add(url);
        reason = globalThis.navigator?.onLine === false ? 'offline' : await this.revalidate(request, file);
      }
      this.stats.hits++;
      if (reason) this.stats[reason]++;
    }
    request.signal.throwIfAborted();
    return this.assemble(request, file, start, end, !!header, fetched);
  }

  private async record(url: string): Promise<Stored | undefined> {
    const db = await this.db;
    if (!db) return;
    let found: IDBRequest | undefined;
    try {
      await transact(db, [M], 'readonly', (meta) => {
        found = meta.get(url);
      });
    } catch {
      this.stats.errors++;
      return;
    }
    return isStored(found?.result) ? found.result : undefined;
  }

  /** The stored file's validators and size against a response's; true when the response cannot tell. */
  private same(file: Stored, response: Response, size: number): boolean {
    const etag = response.headers.get('etag'),
      modified = response.headers.get('last-modified');
    if (size !== file.size) return false;
    if (file.etag && etag) return file.etag === etag;
    if (file.modified && modified) return file.modified === modified;
    return true;
  }

  /** A conditional one-byte request: 'revalidated' when unchanged, 'offline' when it cannot tell; throws CHANGED. */
  private async revalidate(request: Request, file: Stored): Promise<'revalidated' | 'offline'> {
    request.signal.throwIfAborted();
    const headers = new Headers(request.headers),
      controller = new AbortController(),
      abort = () => controller.abort(request.signal.reason);
    headers.set('range', 'bytes=0-0');
    if (file.etag) headers.set('if-none-match', file.etag);
    if (file.modified) headers.set('if-modified-since', file.modified);
    request.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeout),
      sent = Date.now();
    let response: Response;
    try {
      response = await this.network(new Request(request, { headers, signal: controller.signal }));
    } catch (error) {
      if (request.signal.aborted) throw error;
      return 'offline';
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', abort);
    }
    void response.body?.cancel().catch(() => {});
    if (response.status === 304) {
      Object.assign(file, freshnessPolicy(response.headers, Date.now(), sent, false, file));
      this.queue((db) => this.touch(db, file.url, file));
      return 'revalidated';
    }
    const size =
      response.status === 206
        ? contentRange(response.headers.get('content-range'))?.[2]
        : response.status === 200
          ? +(response.headers.get('content-length') ?? Number.NaN)
          : undefined;
    if (size === undefined) return 'offline';
    if (!this.same(file, response, Number.isNaN(size) ? file.size : size)) {
      await this.drop(file.url);
      throw CHANGED;
    }
    return 'revalidated';
  }

  /** Fetches the missing blocks as whole-block ranges, one request per run of adjacent blocks, and stores them. */
  private async download(request: Request, file: Stored, missing: number[]): Promise<Map<number, Blob> | Response> {
    const runs: [number, number][] = [];
    for (const i of missing)
      if (runs.length && runs[runs.length - 1][1] === i - 1) runs[runs.length - 1][1] = i;
      else runs.push([i, i]);
    const got = new Map<number, Blob>(),
      answers = await Promise.all(
        runs.map(async ([a, b]) => {
          const lo = a * this.block,
            hi = Math.min((b + 1) * this.block, file.size) - 1,
            headers = new Headers(request.headers);
          headers.set('range', `bytes=${lo}-${hi}`);
          const response = await this.network(new Request(request, { headers }));
          if (response.status === 206) {
            const range = contentRange(response.headers.get('content-range'));
            if (!range || !this.same(file, response, range[2])) return this.changed(file, response);
            if (range[0] !== lo || range[1] !== hi) return response;
            this.split(await response.blob(), lo, file.size, got);
          } else if (response.status === 200) {
            const blob = await response.blob();
            if (!this.same(file, response, blob.size)) return this.changed(file, response);
            this.split(blob, 0, file.size, got);
          } else return response;
        }),
      ),
      failed = answers.find((answer) => answer instanceof Response);
    if (failed) return failed;
    this.checked.add(file.url);
    this.queue((db) => this.write(db, file, got));
    return got;
  }

  private async changed(file: Stored, response: Response): Promise<never> {
    void response.body?.cancel().catch(() => {});
    await this.drop(file.url);
    throw CHANGED;
  }

  /** Cuts `blob` (the file's bytes from `offset`) into whole blocks; a block cut short by the blob is left out. */
  private split(blob: Blob, offset: number, size: number, into: Map<number, Blob>): void {
    for (let i = Math.ceil(offset / this.block); i * this.block < size; i++) {
      const lo = i * this.block - offset,
        hi = Math.min((i + 1) * this.block, size) - offset;
      if (hi > blob.size) break;
      into.set(i, blob.slice(lo, hi));
    }
  }

  /** A file with nothing stored: the request goes to the network widened to whole blocks, and what comes back is kept. */
  private async miss(request: Request, url: string, header: string | null): Promise<Response> {
    const match = header && /^bytes=(\d+)-(\d*)$/.exec(header.trim());
    let forward = request;
    if (match) {
      const lo = Math.floor(+match[1] / this.block) * this.block,
        hi = match[2] ? `${(Math.floor(+match[2] / this.block) + 1) * this.block - 1}` : '',
        headers = new Headers(request.headers);
      headers.set('range', `bytes=${lo}-${hi}`);
      forward = new Request(request, { headers });
    }
    const sent = Date.now(),
      response = await this.network(forward),
      control = response.headers.get('cache-control') ?? '';
    let offset = 0,
      size: number;
    if (response.status === 206) {
      const range = contentRange(response.headers.get('content-range'));
      if (!range) return response;
      [offset, , size] = range;
    } else if (response.status !== 200) return response;
    // no-store: nothing is kept, but a range widened to whole blocks is still cut back to the range asked for below.
    const keep = !/no-store/i.test(control);
    if (!keep && forward === request) return response;
    const blob = await response.blob(),
      now = Date.now();
    size = response.status === 200 ? blob.size : size!;
    const file: Stored = {
      url,
      size,
      type: response.headers.get('content-type') ?? '',
      etag: response.headers.get('etag'),
      modified: response.headers.get('last-modified'),
      final: response.url || url,
      ...freshnessPolicy(response.headers, now, sent),
      used: now,
      blocks: [],
      bytes: 0,
    };
    const got = new Map<number, Blob>();
    this.stats.misses++;
    if (keep) {
      this.split(blob, offset, size, got);
      this.checked.add(url);
      this.queue((db) => this.write(db, file, got));
    }
    const range = header ? byteRange(header, size) : ([0, size - 1] as [number, number]);
    if (range === 'unsatisfiable')
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    // The request asked for more than came back, or for several ranges: hand the answer over as it is.
    if (!range || range[0] < offset || range[1] >= offset + blob.size)
      return this.respond(file, blob, offset, response.status === 206);
    return this.respond(file, blob.slice(range[0] - offset, range[1] - offset + 1), range[0], !!header);
  }

  /** Answers from stored and just fetched blocks; reads stored blocks in one transaction. */
  private async assemble(
    request: Request,
    file: Stored,
    start: number,
    end: number,
    ranged: boolean,
    fetched: Map<number, Blob>,
  ): Promise<Response> {
    const first = Math.floor(start / this.block),
      last = Math.floor(end / this.block),
      reads = new Map<number, IDBRequest>(),
      db = await this.db;
    if (db)
      await transact(db, [D], 'readonly', (data) => {
        for (let i = first; i <= last; i++) if (!fetched.has(i)) reads.set(i, data.get(key(file.url, i)));
      }).catch(() => {
        this.stats.errors++;
      });
    const parts: Blob[] = [],
      gone: number[] = [];
    for (let i = first; i <= last; i++) {
      const blob = fetched.get(i) ?? (reads.get(i)?.result as Blob | undefined);
      if (blob) parts.push(blob);
      else gone.push(i);
    }
    // A block evicted between the lookup and this read (another tab's write): fetch it once more.
    if (gone.length) {
      const got = await this.download(request, file, gone);
      if (got instanceof Response) return got;
      return this.assemble(request, file, start, end, ranged, new Map([...fetched, ...got]));
    }
    this.queue((db) => this.touch(db, file.url));
    const offset = first * this.block,
      body = new Blob(parts).slice(start - offset, end - offset + 1);
    return this.respond(file, body, start, ranged);
  }

  private respond(file: Stored, body: Blob, start: number, ranged: boolean): Response {
    const headers: Record<string, string> = { 'content-type': file.type, 'content-length': String(body.size) };
    if (file.etag) headers.etag = file.etag;
    if (file.modified) headers['last-modified'] = file.modified;
    if (ranged) headers['content-range'] = `bytes ${start}-${start + body.size - 1}/${file.size}`;
    const response = new Response(body, { status: ranged ? 206 : 200, headers });
    Object.defineProperty(response, 'url', { value: file.final });
    return response;
  }

  /** Refreshes a file's last-used time (and freshness) in the same transaction that reads it. */
  private touch(db: IDBDatabase, url: string, update?: Stored): Promise<void> {
    return transact(db, [M], 'readwrite', (meta) => {
      const found = meta.get(url);
      found.onsuccess = () => {
        if (!isStored(found.result)) return;
        found.result.used = Date.now();
        if (update && found.result.etag === update.etag && found.result.modified === update.modified) {
          found.result.fresh = update.fresh;
          found.result.control = update.control;
          found.result.expires = update.expires;
        }
        meta.put(found.result, url);
      };
    });
  }

  private blockBytes(i: number, size: number): number {
    return Math.min((i + 1) * this.block, size) - i * this.block;
  }

  /** Adds blocks to a file; another version of the file is replaced; least recently used files make room. */
  private async write(db: IDBDatabase, file: Stored, blobs: Map<number, Blob>): Promise<void> {
    let all: IDBRequest | undefined;
    await transact(db, [M], 'readonly', (meta) => {
      all = meta.getAll();
    });
    const records = ((all?.result ?? []) as unknown[]).filter(isStored),
      current = records.find((r) => r.url === file.url),
      same = current && current.size === file.size && current.etag === file.etag && current.modified === file.modified,
      blocks = [...new Set([...(same ? current.blocks : []), ...blobs.keys()])].sort((a, b) => a - b),
      next: Stored = {
        ...(same ? current : file),
        used: Date.now(),
        blocks,
        bytes: blocks.reduce((sum, i) => sum + this.blockBytes(i, file.size), 0),
      },
      others = records.filter((r) => r.url !== file.url).sort((a, b) => a.used - b.used);
    if (next.bytes > this.maxBytes) return;
    const attempt = async (limit: number) => {
      const evict: Stored[] = [];
      for (
        let total = others.reduce((sum, r) => sum + r.bytes, next.bytes), i = 0;
        total > limit && i < others.length;
        i++
      ) {
        total -= others[i].bytes;
        evict.push(others[i]);
      }
      await transact(db, [M, D], 'readwrite', (meta, data) => {
        for (const old of [...evict, ...(current && !same ? [current] : [])]) {
          for (const i of old.blocks) data.delete(key(old.url, i));
          if (old !== current) meta.delete(old.url);
        }
        for (const [i, blob] of blobs) data.put(blob, key(file.url, i));
        meta.put(next, file.url);
      });
      this.stats.stored++;
      this.stats.evicted += evict.length;
    };
    // Over the browser's quota: evict as many more bytes as these blocks need and try once more.
    try {
      await attempt(this.maxBytes);
    } catch (error) {
      if ((error as Error)?.name !== 'QuotaExceededError') throw error;
      await attempt(
        Math.min(
          this.maxBytes,
          others.reduce((sum, r) => sum + r.bytes, 0),
        ),
      );
    }
  }

  /** Drops a file's blocks (after the writes queued so far). */
  private drop(url: string): Promise<void> {
    this.checked.delete(url);
    const done = (this.writes = this.writes
      .then(() => this.db)
      .then(
        (db) =>
          db &&
          transact(db, [M, D], 'readwrite', (meta, data) => {
            const found = meta.get(url);
            found.onsuccess = () => {
              if (isStored(found.result)) for (const i of found.result.blocks) data.delete(key(url, i));
              meta.delete(url);
            };
          }),
      )
      .catch(() => {
        this.stats.errors++;
      }));
    return this.track(done).then(() => {});
  }

  /** Resolves when every write started so far has finished. */
  async flush(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** Bytes, files and blocks stored here. */
  async usage(): Promise<RangeCacheUsage> {
    const db = await this.db;
    let all: IDBRequest | undefined;
    if (db)
      await transact(db, [M], 'readonly', (meta) => {
        all = meta.getAll();
      }).catch(() => {
        this.stats.errors++;
      });
    const records = ((all?.result ?? []) as unknown[]).filter(isStored);
    return {
      bytes: records.reduce((sum, r) => sum + r.bytes, 0),
      files: records.length,
      blocks: records.reduce((sum, r) => sum + r.blocks.length, 0),
    };
  }

  /** Removes one URL's blocks (resolved against the page). */
  async delete(url: string | URL): Promise<void> {
    await this.drop(new URL(url, globalThis.location?.href).href.replace(/#.*/, ''));
  }

  /** Removes every stored block (the version is kept). */
  async clear(): Promise<void> {
    this.checked.clear();
    // After the writes queued so far, as drop: a range answered just before is not stored again after the clear.
    const run = this.writes
      .then(() => this.db)
      .then(
        (db) =>
          db &&
          transact(db, [M, D], 'readwrite', (meta, data) => {
            data.clear();
            meta.getAllKeys().onsuccess = (event) => {
              for (const k of (event.target as IDBRequest<IDBValidKey[]>).result) if (k !== VERSION) meta.delete(k);
            };
          }),
      )
      .then(() => {});
    this.track((this.writes = run.catch(() => {})));
    await run;
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
