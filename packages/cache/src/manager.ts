// One progress, error and abort source for every loader, through the `fetch` option they all take. Each request is one
// item; its body is passed through chunk by chunk (no copy, no read-ahead) so byte progress follows the loader's reads.
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { defaultFetch } from './http.js';

/** A fetch-compatible function, as every loader's `fetch` option takes. */
export type LoadingFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Maps a requested URL to the one actually fetched, for example a blob: URL of a dropped file or a CDN prefix. */
export type URLModifier = (url: string) => string | URL;

/** Byte progress passed to `onProgress`. */
export interface LoadingBytes {
  /** Bytes received for this URL so far. */
  itemLoaded: number;
  /** This URL's Content-Length; undefined when the server sent none or a compressed (Content-Encoding) body. */
  itemTotal: number | undefined;
  /** Bytes received across the current batch. */
  loaded: number;
  /** Sum of the batch's Content-Lengths; undefined while any request of the batch has no known length. */
  total: number | undefined;
}

/** Options for `new LoadingManager(...)`; the callbacks can also be set later as properties. */
export interface LoadingManagerOptions {
  /** Fetch underneath, for example `@margoengine/cache`'s `cache.fetch`. Default `globalThis.fetch` as it is at construction, so setting `globalThis.fetch` to this one later is safe. */
  fetch?: LoadingFetch;
  /** See `LoadingManager.onStart`. */
  onStart?: LoadingManager['onStart'];
  /** See `LoadingManager.onProgress`. */
  onProgress?: LoadingManager['onProgress'];
  /** See `LoadingManager.onLoad`. */
  onLoad?: LoadingManager['onLoad'];
  /** See `LoadingManager.onError`. */
  onError?: LoadingManager['onError'];
}

interface Item {
  url: string;
  fetched: boolean;
  done: boolean;
  loaded: number;
  total?: number;
  /** Ends an in-flight request when the manager aborts. */
  stop?: (reason: unknown) => void;
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * Counts loading work across loaders: pass `manager.fetch` as any loader's `fetch` option (gltf, gltf-pro, loaders,
 * fbx, usdz, blender, environment, audio, ...), and every file it requests, including external
 * buffers and textures the loader resolves, is one item. A batch starts when an item starts while none is pending
 * and ends with `onLoad`. Failed items call `onError` and then count as done, so `onLoad` still follows.
 * `manager.abort()` cancels every request in flight; the manager stays usable for new loads.
 *
 * Compose with AssetCache by wrapping it, `new LoadingManager({fetch: cache.fetch})`, so cache hits are counted too
 * (or the other way round, `new AssetCache({fetch: manager.fetch})`, to count only network requests).
 */
export class LoadingManager {
  /** An item started: its URL (as requested, before the URL modifier), items done and items started this batch. */
  onStart?: (url: string, loaded: number, total: number) => void;
  /** Bytes arrived for `url`, or an item finished (then `loaded` grew); counts are this batch's. */
  onProgress?: (url: string, loaded: number, total: number, bytes: LoadingBytes) => void;
  /** Every item of the batch finished, failed ones included. */
  onLoad?: () => void;
  /** An item failed: a network error, an HTTP error status, an abort or a loader cancelling its body with an error. */
  onError?: (url: string, error: unknown) => void;
  private readonly network: LoadingFetch;
  private modifier?: URLModifier;
  private controller = new AbortController();
  private batch: Item[] = [];
  private finished = 0;
  private received = 0;

  /** @throws TypeError when `fetch` is given and is not a function. */
  constructor({ fetch, onStart, onProgress, onLoad, onError }: LoadingManagerOptions = {}) {
    if (fetch !== undefined && typeof fetch !== 'function')
      throw typeError('LoadingManager fetch is not a function; pass a fetch-compatible function', 'cache');
    this.network = fetch ?? defaultFetch();
    Object.assign(this, { onStart, onProgress, onLoad, onError });
  }

  /** Items finished (or failed) this batch. */
  get loaded(): number {
    return this.finished;
  }
  /** Items started this batch. */
  get total(): number {
    return this.batch.length;
  }
  /** Items still pending. */
  get pending(): number {
    return this.batch.length - this.finished;
  }
  /** Bytes received this batch. */
  get bytesLoaded(): number {
    return this.received;
  }
  /** Sum of this batch's Content-Lengths; undefined while any request has no known length. */
  get bytesTotal(): number | undefined {
    let sum = 0;
    for (const item of this.batch)
      if (item.fetched) {
        if (item.total === undefined) return undefined;
        sum += item.total;
      }
    return sum;
  }
  /** Aborts with `abort()`: pass it to custom work counted with `itemStart`. A new signal follows each abort. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /**
   * Maps every URL the manager fetches (and `resolveURL`) through `modifier`; `undefined` removes it. Callbacks
   * still report the requested URL. When a modifier changes a URL, the response's `url` is the requested one made
   * absolute, so loaders resolve sibling files against it, and those pass through the modifier again.
   * @throws TypeError when `modifier` is neither a function nor undefined.
   */
  setURLModifier(modifier?: URLModifier): this {
    if (modifier !== undefined && typeof modifier !== 'function')
      throw typeError('LoadingManager URL modifier is not a function; pass (url) => string or undefined', 'cache');
    this.modifier = modifier;
    return this;
  }

  /**
   * `url` through the URL modifier (unchanged without one), for custom work that fetches by other means.
   * @throws TypeError when the modifier returns neither a string nor a URL.
   */
  resolveURL(url: string): string {
    if (!this.modifier) return url;
    const mapped = this.modifier(url);
    if (typeof mapped !== 'string' && !(mapped instanceof URL))
      throw typeError(`LoadingManager URL modifier returned ${typeof mapped} for ${url}; return a string URL`, 'cache');
    return String(mapped);
  }

  /** Counts custom (non-fetch) work as one item; finish it with `itemEnd(url)` or `itemError(url, error)`. */
  itemStart(url: string): void {
    this.start(String(url), false);
  }
  /**
   * Finishes the oldest pending custom item for `url`.
   * @throws RangeError when no custom item for `url` is pending.
   */
  itemEnd(url: string): void {
    this.end(this.custom(url, 'itemEnd'));
  }
  /**
   * Fails the oldest pending custom item for `url`: `onError`, then it counts as done.
   * @throws RangeError when no custom item for `url` is pending.
   */
  itemError(url: string, error: unknown): void {
    this.fail(this.custom(url, 'itemError'), error);
  }

  /** Cancels every request in flight; each reports `onError` with `reason` (default an AbortError). */
  abort(reason?: unknown): void {
    const controller = this.controller;
    this.controller = new AbortController();
    controller.abort(reason);
    for (const item of this.batch) if (!item.done) item.stop?.(controller.signal.reason);
  }

  /**
   * Fetch-compatible: pass it as a loader's `fetch` option. Applies the URL modifier, adds the manager's abort signal
   * to the request's own and reports the request and its body's bytes as one item.
   */
  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = typeof Request !== 'undefined' && input instanceof Request ? input : undefined,
      requested = request ? request.url : String(input),
      target = this.resolveURL(requested),
      own = init?.signal ?? request?.signal,
      managed = this.controller.signal,
      signal = own ? AbortSignal.any([own, managed]) : managed;
    const item = this.start(requested, true);
    let response: Response;
    try {
      const pending = this.network(target === requested ? input : request ? new Request(target, request) : target, {
        ...init,
        signal,
      });
      // A network that ignores the signal still lets an abort through.
      response = await new Promise<Response>((resolve, reject) => {
        const stop = () => {
          reject(signal.reason);
          pending.then(
            (late) => late.body?.cancel(signal.reason).catch(() => {}),
            () => {},
          );
        };
        if (signal.aborted) return stop();
        signal.addEventListener('abort', stop, { once: true });
        pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
      });
    } catch (error) {
      this.fail(item, error);
      throw error;
    }
    const url = target === requested ? response.url : absolute(requested);
    if (!response.ok || !response.body || NULL_BODY.has(response.status)) {
      if (response.ok || response.type === 'opaque' || response.type === 'opaqueredirect') this.end(item);
      else
        this.fail(
          item,
          fault(
            'failed',
            `${requested} answered HTTP ${response.status}; check the URL and that the server serves it`,
            'cache',
          ),
        );
      return response;
    }
    const encoding = response.headers.get('content-encoding'),
      length = Number(response.headers.get('content-length') ?? NaN);
    if ((!encoding || encoding === 'identity') && Number.isSafeInteger(length) && length >= 0) item.total = length;
    const reader = response.body.getReader();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    item.stop = (reason) => {
      try {
        source.error(reason);
      } catch {}
      reader.cancel(reason).catch(() => {});
      this.fail(item, reason);
    };
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          source = controller;
        },
        pull: async (controller) => {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch (error) {
            controller.error(error);
            this.fail(item, error);
            return;
          }
          if (item.done) return;
          if (chunk.done) {
            controller.close();
            this.end(item);
            return;
          }
          controller.enqueue(chunk.value);
          this.bytes(item, chunk.value?.byteLength ?? 0);
        },
        cancel: (reason) => {
          if (reason === undefined) this.end(item);
          else this.fail(item, reason);
          return reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    const wrapped = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    Object.defineProperties(wrapped, {
      url: { value: url },
      redirected: { value: response.redirected },
    });
    return wrapped;
  };

  private start(url: string, fetched: boolean): Item {
    if (!this.pending) {
      this.batch = [];
      this.finished = 0;
      this.received = 0;
    }
    const item: Item = { url, fetched, done: false, loaded: 0 };
    this.batch.push(item);
    call(() => this.onStart?.(url, this.finished, this.batch.length));
    return item;
  }
  private bytes(item: Item, count: number): void {
    item.loaded += count;
    this.received += count;
    this.progress(item);
  }
  private progress(item: Item): void {
    call(() =>
      this.onProgress?.(item.url, this.finished, this.batch.length, {
        itemLoaded: item.loaded,
        itemTotal: item.total,
        loaded: this.received,
        total: this.bytesTotal,
      }),
    );
  }
  private end(item: Item): void {
    if (item.done) return;
    item.done = true;
    this.finished++;
    this.progress(item);
    if (!this.pending) call(() => this.onLoad?.());
  }
  private fail(item: Item, error: unknown): void {
    if (item.done) return;
    call(() => this.onError?.(item.url, error));
    this.end(item);
  }
  private custom(url: string, name: string): Item {
    const item = this.batch.find((i) => !i.done && !i.fetched && i.url === String(url));
    if (!item)
      throw rangeError(
        `LoadingManager ${name}(${JSON.stringify(url)}) has no pending item; call itemStart first`,
        'cache',
      );
    return item;
  }
}

/** A callback that throws must not break loading: its error surfaces as an uncaught error instead. */
function call(callback: () => void): void {
  try {
    callback();
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}

function absolute(url: string): string {
  try {
    return new URL(url, globalThis.location?.href).href;
  } catch {
    return '';
  }
}
