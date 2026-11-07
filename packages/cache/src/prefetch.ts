/// <reference lib="esnext.disposable" preserve="true" />
import { margoError } from '../../shared/errors.js';

/** Options for `new Prefetcher(...)`. A `concurrency` under 1 or a negative `idleTimeout` throws a RangeError. */
export interface PrefetcherOptions {
  /** Fetch for each file, normally an AssetCache's `fetch` so the bytes are stored. Default `globalThis.fetch` as it is at construction, so setting `globalThis.fetch` to this one later is safe. */
  fetch?: typeof fetch;
  /** Files fetched at once. Default 2. */
  concurrency?: number;
  /** Start each request in idle time (`requestIdleCallback`, or the next task where there is none). Default true. */
  idle?: boolean;
  /** Longest wait for idle time before a request starts anyway (ms). Default 2000. */
  idleTimeout?: number;
  /** Aborts everything, as `dispose()` does. */
  signal?: AbortSignal;
}
/** One file to prefetch. */
export interface PrefetchItem {
  url: string | URL;
  /** Higher goes first; equal priorities go in the order added. Default 0. */
  priority?: number;
  /** A name to cancel by, such as the level or area. Default `''`. */
  group?: string;
}
/** How one prefetched file ended. */
export interface PrefetchOutcome {
  url: string;
  status: 'done' | 'failed' | 'cancelled';
  /** Body bytes read. */
  bytes: number;
  /** What failed: a network error, or a MargoError `'failed'` for an HTTP error status. */
  error?: unknown;
}
/** Counts of a Prefetcher. */
export interface PrefetchStats {
  /** Files waiting. */
  queued: number;
  /** Files being fetched. */
  active: number;
  done: number;
  failed: number;
  cancelled: number;
  /** Body bytes read. */
  bytes: number;
}
interface Job {
  url: string;
  priority: number;
  group: string;
  order: number;
  controller: AbortController;
  waiters: ((outcome: PrefetchOutcome) => void)[];
}

type Idle = (run: () => void, options: { timeout: number }) => unknown;

/**
 * Fetches the files the app will need next (the next level, the area ahead) in idle time, highest priority first, a few
 * at a time, so they are in the cache before they are asked for. Pass an AssetCache's `fetch` as `fetch`; wrap that
 * cache's network in {@link throttle} to cap the bandwidth prefetching takes. Each file is read to its end, so the cache
 * stores it. A file is fetched once per Prefetcher; adding it again only raises its priority while it waits.
 */
export class Prefetcher {
  private readonly queue: Job[] = [];
  private readonly running = new Set<Job>();
  private readonly seen = new Map<string, Job | PrefetchOutcome>();
  private readonly network: typeof globalThis.fetch;
  private readonly concurrency: number;
  private readonly idle: boolean;
  private readonly idleTimeout: number;
  private readonly settled: (() => void)[] = [];
  private order = 0;
  private holds = 0;
  private paused = false;
  private scheduled = false;
  private disposed = false;
  private counts = { done: 0, failed: 0, cancelled: 0, bytes: 0 };

  constructor({ fetch, concurrency = 2, idle = true, idleTimeout = 2000, signal }: PrefetcherOptions = {}) {
    if (!(concurrency >= 1) || !(idleTimeout >= 0))
      throw new RangeError('Prefetcher concurrency must be at least 1 and idleTimeout non-negative');
    // globalThis.fetch as it is now: read later, `globalThis.fetch = x.fetch` would make this call itself without end.
    const base = globalThis.fetch;
    this.network = fetch ?? ((input, init) => (base ?? globalThis.fetch)(input, init));
    this.concurrency = concurrency;
    this.idle = idle;
    this.idleTimeout = idleTimeout;
    if (signal?.aborted) this.dispose();
    else signal?.addEventListener('abort', () => this.dispose(), { once: true });
  }

  /** Counts so far. */
  get stats(): PrefetchStats {
    return { queued: this.queue.length, active: this.running.size, ...this.counts };
  }

  /**
   * Queues files; resolves with how each one ended once all have. A URL already done, failed or cancelled in this
   * Prefetcher is not fetched again and resolves with that outcome.
   */
  add(
    items: string | URL | PrefetchItem | readonly (string | URL | PrefetchItem)[],
    defaults: { priority?: number; group?: string } = {},
  ): Promise<PrefetchOutcome[]> {
    const list = (Array.isArray(items) ? items : [items]) as (string | URL | PrefetchItem)[];
    const outcomes = list.map((item) => {
      const spec = typeof item === 'string' || item instanceof URL ? { url: item } : item,
        url = new URL(spec.url, globalThis.location?.href).href,
        priority = spec.priority ?? defaults.priority ?? 0,
        group = spec.group ?? defaults.group ?? '',
        known = this.seen.get(url);
      if (this.disposed) return Promise.resolve<PrefetchOutcome>({ url, status: 'cancelled', bytes: 0 });
      if (known && !('controller' in known)) return Promise.resolve(known);
      return new Promise<PrefetchOutcome>((resolve) => {
        if (known) {
          if (priority > known.priority) known.priority = priority;
          known.waiters.push(resolve);
          return;
        }
        const job: Job = {
          url,
          priority,
          group,
          order: this.order++,
          controller: new AbortController(),
          waiters: [resolve],
        };
        this.seen.set(url, job);
        this.queue.push(job);
      });
    });
    this.pump();
    return Promise.all(outcomes);
  }

  /** Drops waiting files of `group` (every group when omitted) and aborts the ones in flight. Returns how many. */
  cancel(group?: string): number {
    let n = 0;
    for (const job of [...this.queue, ...this.running])
      if (group === undefined || job.group === group) {
        n++;
        const at = this.queue.indexOf(job);
        if (at >= 0) {
          this.queue.splice(at, 1);
          this.finish(job, { url: job.url, status: 'cancelled', bytes: 0 });
        } else job.controller.abort(new DOMException('Prefetch cancelled', 'AbortError'));
      }
    return n;
  }

  /** Starts no new request until `resume()`; requests in flight go on. */
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
    this.pump();
  }
  /** Starts no new request while `work` (a foreground load) runs, and passes its result through. */
  async hold<T>(work: Promise<T>): Promise<T> {
    this.holds++;
    try {
      return await work;
    } finally {
      this.holds--;
      this.pump();
    }
  }
  /** Resolves when nothing is waiting or in flight. */
  settle(): Promise<void> {
    if (!this.queue.length && !this.running.size) return Promise.resolve();
    return new Promise((resolve) => this.settled.push(resolve));
  }

  private whenIdle(run: () => void): void {
    const idle = (globalThis as { requestIdleCallback?: Idle }).requestIdleCallback;
    if (this.idle && idle) idle(run, { timeout: this.idleTimeout });
    else setTimeout(run, 0);
  }

  private pump(): void {
    if (this.scheduled || this.paused || this.holds || this.disposed) return;
    if (!this.queue.length || this.running.size >= this.concurrency) {
      if (!this.queue.length && !this.running.size) for (const resolve of this.settled.splice(0)) resolve();
      return;
    }
    this.scheduled = true;
    this.whenIdle(() => {
      this.scheduled = false;
      if (this.paused || this.holds || this.disposed || this.running.size >= this.concurrency) return;
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const a = this.queue[i],
          b = this.queue[best];
        if (a.priority > b.priority || (a.priority === b.priority && a.order < b.order)) best = i;
      }
      const job = this.queue.splice(best, 1)[0];
      if (job) void this.run(job);
      this.pump();
    });
  }

  private async run(job: Job): Promise<void> {
    this.running.add(job);
    let bytes = 0;
    try {
      const response = await this.network(job.url, { signal: job.controller.signal, priority: 'low' } as RequestInit);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw margoError('failed', `Prefetch of ${job.url} answered HTTP ${response.status}; check the URL`);
      }
      const reader = response.body?.getReader();
      for (let chunk = await reader?.read(); chunk && !chunk.done; chunk = await reader!.read())
        bytes += chunk.value.byteLength;
      this.finish(job, { url: job.url, status: 'done', bytes });
    } catch (error) {
      const cancelled = job.controller.signal.aborted;
      this.finish(job, {
        url: job.url,
        status: cancelled ? 'cancelled' : 'failed',
        bytes,
        ...(!cancelled && { error }),
      });
    } finally {
      this.running.delete(job);
      this.pump();
    }
  }

  private finish(job: Job, outcome: PrefetchOutcome): void {
    this.counts[outcome.status]++;
    this.counts.bytes += outcome.bytes;
    // A cancelled file may be added again later.
    if (outcome.status === 'cancelled') this.seen.delete(job.url);
    else this.seen.set(job.url, outcome);
    for (const resolve of job.waiters.splice(0)) resolve(outcome);
  }

  /** Cancels everything; later `add` calls resolve as cancelled. */
  dispose(): void {
    this.cancel();
    this.disposed = true;
    for (const resolve of this.settled.splice(0)) resolve();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/** Options for `throttle(...)`. */
export interface ThrottleOptions {
  /** Body bytes per second over every response of the returned fetch together. */
  bytesPerSecond: number;
  /** Bytes read at full speed before the limit applies. Default a quarter second's worth. */
  burst?: number;
}

/**
 * A fetch whose response bodies are read no faster than `bytesPerSecond`, shared by every request made through it. The
 * browser's buffers and TCP flow control then slow the download itself to match. Give it to the AssetCache that
 * prefetching goes through (`new AssetCache({name, fetch: throttle(fetch, {bytesPerSecond})})`, the same `name` as
 * the app's own cache) so foreground loads keep the full bandwidth.
 * @throws RangeError when `bytesPerSecond` is not positive or `burst` is negative.
 */
export function throttle(
  fetch: typeof globalThis.fetch,
  { bytesPerSecond, burst = bytesPerSecond / 4 }: ThrottleOptions,
): typeof globalThis.fetch {
  if (!(bytesPerSecond > 0) || !(burst >= 0))
    throw new RangeError('throttle bytesPerSecond must be positive and burst non-negative');
  // When the bytes read so far are paid for at the rate; reading waits while that runs ahead by more than the burst.
  let paid = 0;
  const wait = (bytes: number, signal?: AbortSignal | null) => {
    const now = performance.now();
    paid = Math.max(paid, now - (burst / bytesPerSecond) * 1e3) + (bytes / bytesPerSecond) * 1e3;
    const delay = paid - now;
    if (delay <= 0) return;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  };
  return async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined),
      response = await fetch(input, init);
    if (!response.body) return response;
    const reader = response.body.getReader(),
      body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const chunk = await reader.read();
          if (chunk.done) return controller.close();
          await wait(chunk.value.byteLength, signal);
          controller.enqueue(chunk.value);
        },
        cancel: (reason) => reader.cancel(reason),
      }),
      out = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    Object.defineProperty(out, 'url', { value: response.url });
    return out;
  };
}
