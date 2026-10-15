import { LoaderError } from './types.js';

export interface FetchOptions {
  signal?: AbortSignal;
  /** Maximum response size in bytes. Default 256 MiB. */
  maxBytes?: number;
  /** Custom fetch, for example one that adds credentials. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Extra `RequestInit` (headers, credentials, ...). */
  init?: RequestInit;
}

const F = 'load';
export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

/** Fetches `url` into memory, enforcing `maxBytes` on both Content-Length and the streamed body. */
export async function fetchBytes(url: string | URL, options: FetchOptions = {}): Promise<Uint8Array> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new LoaderError(F, 'range', 'maxBytes must be a non-negative integer');
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') throw new LoaderError(F, 'unsupported', 'fetch is not available');
  if (options.signal?.aborted)
    throw new LoaderError(F, 'aborted', `aborted before fetching ${String(url).slice(0, 200)}`);
  let response: Response;
  try {
    response = await doFetch(url, { ...options.init, signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted)
      throw new LoaderError(F, 'aborted', `aborted while fetching ${String(url).slice(0, 200)}`);
    throw new LoaderError(
      F,
      'fetch',
      `request for ${String(url).slice(0, 200)} failed (${(error as Error)?.message ?? error})`,
    );
  }
  if (!response.ok)
    throw new LoaderError(F, 'fetch', `request for ${String(url).slice(0, 200)} returned HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new LoaderError(F, 'limit', `response is ${declared} bytes, more than the limit of ${maxBytes}`);
  }
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.length > maxBytes)
      throw new LoaderError(F, 'limit', `response is ${buffer.length} bytes, more than the limit of ${maxBytes}`);
    return buffer;
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) throw new LoaderError(F, 'limit', `response exceeds the limit of ${maxBytes} bytes`);
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof LoaderError) throw error;
    if (options.signal?.aborted)
      throw new LoaderError(F, 'aborted', `aborted while reading ${String(url).slice(0, 200)}`);
    throw new LoaderError(
      F,
      'fetch',
      `reading ${String(url).slice(0, 200)} failed (${(error as Error)?.message ?? error})`,
    );
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Fetches `url` and parses it with `parse`, for example `load('/scan.ply', parsePLY, {signal, maxVertices: 1e6})`.
 * The same options object goes to the parser, so limits and `signal` apply to both steps.
 */
export async function load<T, O extends object = object>(
  url: string | URL,
  parse: (input: Uint8Array, options?: O) => T | Promise<T>,
  options?: O & FetchOptions,
): Promise<T> {
  const bytes = await fetchBytes(url, options);
  if (options?.signal?.aborted) throw new LoaderError(F, 'aborted', 'aborted');
  return parse(bytes, options);
}
