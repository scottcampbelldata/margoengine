export interface LoadAudioOptions {
  /** Rejects this caller with an AbortError. The download itself is cancelled once every waiting caller aborted. */
  signal?: AbortSignal;
  /** Share and keep the decoded buffer per context and URL. Default true. */
  cache?: boolean;
  /** Custom fetch, for example one that adds headers. Default `globalThis.fetch`. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

interface Entry {
  promise: Promise<AudioBuffer>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}
const caches = new WeakMap<BaseAudioContext, Map<string, Entry>>();

const abortError = (signal?: AbortSignal): unknown =>
  signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');

/** Wraps both the promise and the legacy callback forms of `decodeAudioData`. */
export function decodeAudio(context: BaseAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    const result = context.decodeAudioData(bytes, resolve, (error) =>
      reject(error ?? new Error('Audio decoding failed')),
    );
    if (result && typeof result.then === 'function') result.then(resolve, reject);
  });
}

/**
 * Fetches and decodes an audio file into an AudioBuffer (THREE.AudioLoader counterpart). Concurrent and repeated
 * requests for the same URL on the same context share one download and one decoded buffer.
 */
export function loadAudioBuffer(
  context: BaseAudioContext,
  url: string,
  options: LoadAudioOptions = {},
): Promise<AudioBuffer> {
  const { signal, cache = true } = options;
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const fetcher = options.fetch ?? (globalThis.fetch as LoadAudioOptions['fetch']);
  if (!fetcher) return Promise.reject(new Error('fetch is unavailable in this environment'));
  let map = caches.get(context);
  if (!map) {
    map = new Map();
    caches.set(context, map);
  }
  const key = String(url);
  let entry = cache ? map.get(key) : undefined;
  if (!entry) {
    const controller = new AbortController();
    const created: Entry = {
      controller,
      waiters: 0,
      settled: false,
      promise: (async () => {
        const response = await fetcher(key, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status} loading ${key}`);
        const bytes = await response.arrayBuffer();
        controller.signal.throwIfAborted();
        return decodeAudio(context, bytes);
      })(),
    };
    created.promise.then(
      () => {
        created.settled = true;
      },
      () => {
        created.settled = true;
        if (map!.get(key) === created) map!.delete(key);
      },
    );
    if (cache) map.set(key, created);
    entry = created;
  }
  const shared = entry;
  shared.waiters++;
  return new Promise<AudioBuffer>((resolve, reject) => {
    let done = false;
    const finish = (): boolean => {
      if (done) return false;
      done = true;
      shared.waiters--;
      signal?.removeEventListener('abort', onAbort);
      return true;
    };
    const onAbort = (): void => {
      if (!finish()) return;
      reject(abortError(signal));
      if (shared.waiters === 0 && !shared.settled) {
        shared.controller.abort();
        if (map!.get(key) === shared) map!.delete(key);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    shared.promise.then(
      (buffer) => {
        if (finish()) resolve(buffer);
      },
      (error) => {
        if (finish()) reject(error);
      },
    );
  });
}

/** Drops cached buffers for one context, or for one URL on that context. */
export function clearAudioBufferCache(context: BaseAudioContext, url?: string): void {
  const map = caches.get(context);
  if (!map) return;
  if (url === undefined) map.clear();
  else map.delete(String(url));
}
