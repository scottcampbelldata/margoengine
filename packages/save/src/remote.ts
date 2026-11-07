// Cloud saves over plain HTTP: one URL per key, GET, PUT and DELETE, and the conditional requests of RFC 9110 for the
// conflict policy. A read remembers the key's ETag; a write sends it as If-Match, or If-None-Match: * when this client
// has never seen the key, so a save another device made in between is found by the server, never overwritten. A 412 is
// a conflict, unless the server already holds exactly these bytes: then it is this client's own write whose response
// was lost (RFC 9110, 13.1.1). A function policy merges per write, in the manner of Bayou's merge procedures (Terry et
// al., SOSP 1995). remoteHandler is the other half, a server for any storage in the shape of a fetch handler.
import { MargoError } from '@margoengine/math/errors';
import { keyQueue } from './queue.js';
import type { SaveStorage, StorageCallOptions } from './storage.js';

/** What two devices disagree on. `null` is a key that is not there. */
export interface SaveConflict {
  key: string;
  /** What this client wanted to store; null for a delete. */
  local: Uint8Array | null;
  /** What the server holds now. */
  remote: Uint8Array | null;
}

/** Returns what the key should hold, or null for nothing. Return `remote` to keep it. */
export type ConflictResolver = (conflict: SaveConflict) => Uint8Array | null | Promise<Uint8Array | null>;

/** Options of {@link remoteStorage}. */
export interface RemoteStorageOptions {
  /** The folder of saves: a key lives at `${url}/${encodeURIComponent(key)}`, and GET on `url` lists keys as JSON. */
  url: string | URL;
  /** Default `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Sent with each request. A function runs for each attempt, for a token that expires. Default none. */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /**
   * When the server's save is not the one this client last saw. `'error'` rejects and changes nothing, `'local'` writes
   * over it, `'remote'` keeps it and drops this write, and a function merges the two. Default `'error'`.
   */
  conflict?: 'error' | 'local' | 'remote' | ConflictResolver;
  /** Milliseconds for one attempt. Default 30,000. */
  timeout?: number;
  /** Further attempts after a network failure, a timeout, a 429 or a 5xx. Default 3. */
  retries?: number;
}

const RETRY = new Set([408, 429, 500, 502, 503, 504]),
  LONGEST_WAIT = 60_000,
  // A write that keeps meeting newer saves gives up after this many tries.
  CONFLICT_TRIES = 5,
  isOk = (status: number): boolean => status >= 200 && status < 300;

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);

/** Milliseconds a Retry-After value asks for, as seconds or an HTTP date (RFC 9110, 10.2.3); null when there is none. */
function retryAfter(value: string | null): number | null {
  if (value === null) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

const pause = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const stop = (): void => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', stop, { once: true });
  });

/**
 * Saves on an HTTP server, with conflicts found by the server through ETags. Read a key before writing it on a new
 * device, or the write counts as a conflict with what is there. The server must send a strong ETag; a weak one is asked
 * for again before a write, since a server can go from one to the other once a change has settled.
 * @example
 * const storage = remoteStorage({ url: 'https://example.com/saves', headers: () => ({ authorization: `Bearer ${token()}` }) });
 * await saveGame(storage, 'slot-1', document);
 */
export function remoteStorage(options: RemoteStorageOptions): SaveStorage {
  if (!options?.url) throw new TypeError("remoteStorage needs a url, e.g. { url: 'https://example.com/saves' }");
  const { headers, conflict = 'error', timeout = 30_000, retries = 3 } = options,
    url = String(options.url).replace(/\/+$/, ''),
    send = options.fetch ?? globalThis.fetch,
    tags = new Map<string, string | null>(),
    // What a weak tag stood for: such a tag can go strong later (a server not yet sure of a file just changed).
    weak = new Map<string, Uint8Array>(),
    turn = keyQueue();
  if (typeof send !== 'function')
    throw new MargoError('unsupported', 'There is no fetch here; pass options.fetch');
  if (typeof conflict !== 'function' && !['error', 'local', 'remote'].includes(conflict))
    throw new TypeError("conflict must be 'error', 'local', 'remote' or a function");
  if (!(timeout > 0)) throw new RangeError('timeout must be above 0 milliseconds');
  if (!Number.isInteger(retries) || retries < 0) throw new RangeError('retries must be a whole number of 0 or more');

  const address = (key: string): string => {
    if (typeof key !== 'string' || !key) throw new TypeError('Save key must be a non-empty string, e.g. "slot-1"');
    return `${url}/${encodeURIComponent(key)}`;
  };

  /** One request, tried again within `retries`, with its body read inside the attempt's time limit. */
  const request = async (
    target: string,
    init: RequestInit,
    call: StorageCallOptions | undefined,
  ): Promise<{ status: number; etag: string | null; body: Uint8Array }> => {
    const signal = call?.signal;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      let problem: unknown,
        wait: number | null = null;
      try {
        const limit = AbortSignal.timeout(timeout),
          extra = typeof headers === 'function' ? await headers() : headers,
          merged = new Headers(extra);
        new Headers(init.headers).forEach((value, name) => merged.set(name, value));
        const response = await send(target, {
            ...init,
            headers: merged,
            cache: 'no-store',
            signal: signal ? AbortSignal.any([signal, limit]) : limit,
          }),
          body = new Uint8Array(await response.arrayBuffer());
        if (!RETRY.has(response.status)) return { status: response.status, etag: response.headers.get('etag'), body };
        problem = new MargoError('failed', `The save server answered ${response.status} for ${target}; try again later`);
        wait = retryAfter(response.headers.get('retry-after'));
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof MargoError) throw error;
        problem = Object.assign(
          new MargoError(
            (error as Error)?.name === 'TimeoutError' ? 'timeout' : 'failed',
            `The save server did not answer for ${target}; check the connection, or raise timeout`,
          ),
          { cause: error },
        );
      }
      if (attempt >= retries) throw problem;
      // Full jitter, so devices that failed together do not come back together.
      const delay = wait ?? Math.random() * 200 * 2 ** attempt;
      if (delay > LONGEST_WAIT) throw problem;
      await pause(delay, signal);
    }
  };

  const refused = (status: number, what: string): MargoError =>
    new MargoError(
      'failed',
      status === 401 || status === 403
        ? `The save server refused ${what} (${status}); check the headers option`
        : `The save server answered ${status} for ${what}; check that url points at a save folder`,
    );

  /** What the server holds now, remembering its tag. */
  const fetchKey = async (key: string, call?: StorageCallOptions): Promise<Uint8Array | null> => {
    const { status, etag, body } = await request(address(key), { method: 'GET' }, call);
    if (status === 404 || status === 410) {
      tags.set(key, null);
      return null;
    }
    if (!isOk(status)) throw refused(status, `reading '${key}'`);
    tags.set(key, etag ?? '');
    if (etag?.startsWith('W/')) weak.set(key, body);
    else weak.delete(key);
    return body;
  };

  /** The precondition for what this client last saw of `key`. */
  const condition = (key: string, write: boolean): Record<string, string> => {
    const tag = tags.get(key);
    if (tag === '')
      throw new MargoError('unsupported', `The save server sent no ETag for '${key}'; conflicts need one, so turn on ETags on that server`);
    if (tag?.startsWith('W/'))
      throw new MargoError(
        'unsupported',
        `The save server gave '${key}' a weak ETag (${tag}), which If-Match never matches; make that server send strong ETags, or wait a moment if it just changed`,
      );
    if (typeof tag === 'string') return { 'if-match': tag };
    return write ? { 'if-none-match': '*' } : {};
  };

  /** If the tag is weak, asks again: true when the key still holds what the tag stood for. */
  const unchanged = async (key: string, call?: StorageCallOptions): Promise<boolean> => {
    const seen = weak.get(key);
    if (!seen || !tags.get(key)?.startsWith('W/')) return true;
    const now = await fetchKey(key, call);
    return now !== null && same(now, seen);
  };

  /** Puts `bytes`, or removes the key for null, working through conflicts. Resolves whether the key held anything. */
  const store = async (key: string, bytes: Uint8Array | null, call?: StorageCallOptions): Promise<boolean> => {
    let wanted = bytes;
    for (let tries = 0; tries < CONFLICT_TRIES; tries++) {
      const { status, etag } = !(await unchanged(key, call))
        ? { status: 412, etag: null }
        : wanted === null
          ? await request(address(key), { method: 'DELETE', headers: condition(key, false) }, call)
          : await request(
              address(key),
              {
                method: 'PUT',
                headers: { 'content-type': 'application/octet-stream', ...condition(key, true) },
                body: wanted as BodyInit,
              },
              call,
            );
      if (isOk(status)) {
        if (wanted === null) tags.set(key, null);
        else if (etag !== null) tags.set(key, etag);
        else {
          // A 2xx need not name a tag. If what is there now is not ours, forget the tag: the next write finds out.
          tags.delete(key);
          const now = await fetchKey(key, call);
          if (!now || !same(now, wanted)) tags.delete(key);
        }
        return true;
      }
      if (status === 404 && wanted === null) {
        tags.set(key, null);
        return false;
      }
      if (status !== 412) throw refused(status, `saving '${key}'`);
      const remote = await fetchKey(key, call);
      // The server holds what was asked for: this client's own write landed and its answer was lost.
      if (remote === null ? wanted === null : wanted !== null && same(remote, wanted)) return wanted !== null;
      if (conflict === 'error')
        throw new MargoError(
          'state',
          `Save '${key}' changed on the server since this client read it; read it again, or set conflict to 'local', 'remote' or a function`,
        );
      if (conflict === 'remote') return remote !== null;
      if (typeof conflict === 'function') {
        wanted = await conflict({ key, local: wanted, remote });
        if (wanted === null ? remote === null : remote !== null && same(wanted, remote)) return remote !== null;
      }
    }
    throw new MargoError('state', `Save '${key}' kept changing on the server while this client wrote it; save again later`);
  };

  return {
    async read(key, call) {
      address(key);
      return turn(key, () => fetchKey(key, call));
    },
    async write(key, bytes, call) {
      address(key);
      if (!(bytes instanceof Uint8Array))
        throw new TypeError('Save bytes must be a Uint8Array; encode the document with encodeSave');
      await turn(key, () => store(key, bytes, call));
    },
    async delete(key, call) {
      address(key);
      return turn(key, () => store(key, null, call));
    },
    async keys(call) {
      const { status, body } = await request(url, { method: 'GET', headers: { accept: 'application/json' } }, call);
      if (!isOk(status)) throw refused(status, 'the list of saves');
      let names: unknown;
      try {
        names = JSON.parse(new TextDecoder().decode(body));
      } catch (error) {
        throw Object.assign(new TypeError(`The list at ${url} is not JSON; serve an array of keys there`), { cause: error });
      }
      if (!Array.isArray(names) || names.some((name) => typeof name !== 'string'))
        throw new TypeError(`The list at ${url} is not an array of strings; serve an array of keys there`);
      return (names as string[]).slice().sort();
    },
  };
}

/** Options of {@link remoteHandler}. */
export interface RemoteHandlerOptions {
  /** The path the saves sit under. Default `'/'`. */
  base?: string;
  /** The `Access-Control-Allow-Origin` value, for a page on another origin. Default none: same origin only. */
  origin?: string;
  /** Request headers a page may send, beside the conditional ones. Default `['authorization', 'content-type']`. */
  allowHeaders?: readonly string[];
  /** Largest save it takes, in bytes. Default 64 MiB. */
  maxBytes?: number;
  /** Runs first on each request; false answers 403. Default none, so every caller can read and write. */
  authorize?(request: Request): boolean | Promise<boolean>;
}

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** The ETag of some bytes: a strong tag, the same for the same bytes on any server. */
const entityTag = async (bytes: Uint8Array): Promise<string> =>
  `"${hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource)).slice(0, 32)}"`;

/** The tags a list header names; the whole of `*` is the string '*'. */
const listed = (value: string): string[] | '*' =>
  value.trim() === '*' ? '*' : value.split(',').map((tag) => tag.trim()).filter(Boolean);

/**
 * A save server over any storage: takes a fetch `Request` and gives a `Response`, so it runs in a service worker,
 * Deno, Bun or a Node server with a few lines around it. A key's writes run one at a time, so a precondition and its
 * write cannot be split by another request of this handler.
 * @example
 * const handle = remoteHandler(fileStorage('./saves'), { base: '/saves', authorize: (request) => signedIn(request) });
 */
export function remoteHandler(storage: SaveStorage, options: RemoteHandlerOptions = {}): (request: Request) => Promise<Response> {
  if (typeof storage?.read !== 'function') throw new TypeError('remoteHandler needs a storage, e.g. fileStorage(folder)');
  const { origin, allowHeaders = ['authorization', 'content-type'], maxBytes = 64 * 1024 * 1024, authorize } = options,
    base = (options.base ?? '/').replace(/\/+$/, ''),
    turn = keyQueue();
  const cors: Record<string, string> = origin
    ? { 'access-control-allow-origin': origin, 'access-control-expose-headers': 'ETag, Retry-After' }
    : {};
  const answer = (status: number, body: BodyInit | null = null, headers: Record<string, string> = {}): Response =>
    new Response(body, { status, headers: { 'cache-control': 'no-store', ...cors, ...headers } });
  const methods = 'GET, PUT, DELETE, OPTIONS';

  const preconditionFails = (request: Request, tag: string | null): boolean => {
    const match = request.headers.get('if-match'),
      none = request.headers.get('if-none-match');
    if (match !== null) {
      const tags = listed(match);
      // Strong comparison: a weak tag on either side never matches (RFC 9110, 8.8.3.2).
      if (tag === null || (tags !== '*' && !tags.includes(tag))) return true;
    }
    if (none !== null) {
      const tags = listed(none);
      // Weak comparison here (RFC 9110, 13.1.2).
      if (tag !== null && (tags === '*' || tags.includes(tag) || tags.includes(`W/${tag}`))) return true;
    }
    return false;
  };

  const onKey = async (request: Request, key: string): Promise<Response> => {
    const signal = request.signal,
      stored = await storage.read(key, { signal }),
      tag = stored && (await entityTag(stored));
    if (request.method === 'GET') {
      if (!stored) return answer(404);
      return answer(200, stored as BodyInit, { etag: tag!, 'content-type': 'application/octet-stream' });
    }
    if (preconditionFails(request, tag)) return answer(412, null, tag ? { etag: tag } : {});
    if (request.method === 'DELETE') {
      if (!stored) return answer(404);
      await storage.delete(key, { signal });
      return answer(204);
    }
    const size = Number(request.headers.get('content-length') ?? 0);
    if (size > maxBytes) return answer(413);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > maxBytes) return answer(413);
    await storage.write(key, bytes, { signal });
    return answer(stored ? 204 : 201, null, { etag: await entityTag(bytes) });
  };

  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path !== base && !path.startsWith(`${base}/`)) return answer(404);
    if (request.method === 'OPTIONS')
      return answer(204, null, {
        allow: methods,
        ...(origin
          ? {
              'access-control-allow-methods': methods,
              'access-control-allow-headers': ['if-match', 'if-none-match', ...allowHeaders].join(', '),
              'access-control-max-age': '600',
            }
          : {}),
      });
    if (authorize && !(await authorize(request))) return answer(403);
    const name = path.slice(base.length + 1);
    if (!name) {
      if (request.method !== 'GET') return answer(405, null, { allow: 'GET, OPTIONS' });
      return answer(200, JSON.stringify(await storage.keys({ signal: request.signal })), { 'content-type': 'application/json' });
    }
    if (!['GET', 'PUT', 'DELETE'].includes(request.method)) return answer(405, null, { allow: methods });
    let key: string;
    try {
      key = decodeURIComponent(name);
    } catch {
      return answer(400);
    }
    return turn(key, () => onKey(request, key));
  };
}
