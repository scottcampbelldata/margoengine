import { fault, rangeError, typeError } from '../../shared/errors.js';
import type { ZarrStore } from './formats.js';

/** A byte range: offset >= 0, or a negative offset for the final length bytes. */
export interface CloudRange {
  readonly offset: number;
  readonly length: number;
}

/** Immutable object storage, with bounded partial reads for shard indexes and payloads. */
export interface CloudStore {
  get(key: string, signal?: AbortSignal, range?: CloudRange): Promise<Uint8Array | undefined>;
}

/** HTTP/S3 request options. S3 URLs use the public virtual-hosted HTTPS endpoint. */
export interface CloudStoreOptions {
  readonly init?: RequestInit;
  readonly signal?: AbortSignal;
  /** Maximum bytes per response, including servers ignoring Range. Default 64 MiB. */
  readonly maxBytes?: number;
}

/** A cloud store, existing Zarr store, or URL (including s3://bucket/prefix). */
export type CloudInput = CloudStore | ZarrStore;

/** Validates a relative object key without permitting URL escapes. */
export function cloudPath(path: string): string {
  if (
    typeof path !== 'string' ||
    path.includes('\\') ||
    /[?#:]/.test(path) ||
    path.split('/').some((p) => p === '.' || p === '..')
  )
    throw rangeError('Cloud path must be relative; remove URL escapes and dot segments', 'sciviz');
  return path.replace(/^\/+|\/+$/g, '');
}

/** Builds a bounded HTTP Range or in-memory object store. No requests occur until get(). */
export function cloudStore(input: CloudInput, options: CloudStoreOptions = {}): CloudStore {
  const max = options.maxBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(max) || max < 32) throw rangeError('Cloud maxBytes must be at least 32', 'sciviz');
  let read: CloudStore['get'];
  if (typeof input === 'string' || input instanceof URL) {
    let url = new URL(input, globalThis.location?.href);
    if (url.protocol === 's3:') {
      url = new URL(`https://${url.hostname}.s3.amazonaws.com${url.pathname}${url.search}`);
    }
    if (!['https:', 'http:'].includes(url.protocol)) throw rangeError('Cloud URL must use HTTP, HTTPS or S3', 'sciviz');
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    read = async (key, signal, range) => {
      const headers = new Headers(options.init?.headers);
      if (range)
        headers.set(
          'Range',
          range.offset < 0 ? `bytes=-${range.length}` : `bytes=${range.offset}-${range.offset + range.length - 1}`,
        );
      const response = await fetch(new URL(key.split('/').map(encodeURIComponent).join('/'), url), {
        ...options.init,
        headers,
        signal,
      });
      if (response.status === 404) return undefined;
      if (!response.ok)
        throw fault('failed', `Cloud fetch of ${key} returned HTTP ${response.status}; check permissions`, 'sciviz');
      let declared: number | undefined;
      if (response.status === 206) {
        const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
        const start = m ? Number(m[1]) : -1,
          end = m ? Number(m[2]) : -1,
          total = m ? Number(m[3]) : -1;
        const expected = range ? (range.offset < 0 ? Math.max(0, total - range.length) : range.offset) : -1;
        if (
          !range ||
          !m ||
          start !== expected ||
          end < start ||
          end >= total ||
          end - start + 1 !== Math.min(range.length, total - start)
        )
          throw rangeError('Cloud response has an incorrect Content-Range; check the server', 'sciviz');
        declared = end - start + 1;
      }
      const reader = response.body?.getReader();
      if (!reader) throw rangeError('Cloud response has no body; check the server', 'sciviz');
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > Math.min(max, declared ?? max))
            throw rangeError('Cloud response exceeds maxBytes; use smaller chunks or enable Range', 'sciviz');
          parts.push(part.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      if (declared !== undefined && declared !== size)
        throw rangeError('Cloud response is truncated; check the server', 'sciviz');
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const part of parts) {
        bytes.set(part, at);
        at += part.length;
      }
      if (!range || response.status === 206) return bytes;
      const start = range.offset < 0 ? Math.max(0, size - range.length) : range.offset;
      return bytes.slice(start, start + range.length);
    };
  } else if (input && typeof (input as CloudStore).get === 'function')
    read = (key, signal, range) => (input as CloudStore).get(key, signal, range);
  else {
    const old = input as Exclude<ZarrStore, string | URL>;
    if (!old || (typeof old !== 'object' && typeof old !== 'function'))
      throw typeError('Cloud store needs a URL, key map or get function', 'sciviz');
    read = async (key, signal, range) => {
      const value = typeof old === 'function' ? await old(key, signal) : Object.hasOwn(old, key) ? old[key] : undefined;
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
      if (!bytes || !range) return bytes;
      const start = range.offset < 0 ? Math.max(0, bytes.length - range.length) : range.offset;
      return bytes.slice(start, start + range.length);
    };
  }
  return {
    async get(key, signal, range) {
      const active = signal && options.signal ? AbortSignal.any([signal, options.signal]) : (signal ?? options.signal);
      active?.throwIfAborted();
      if (
        range &&
        (!Number.isSafeInteger(range.offset) ||
          !Number.isSafeInteger(range.length) ||
          range.length < 1 ||
          range.length > max ||
          (range.offset < 0 && range.offset !== -range.length) ||
          !Number.isSafeInteger(range.offset + range.length))
      )
        throw rangeError('Cloud range must be safe, bounded bytes; use a negative length for a suffix', 'sciviz');
      const bytes = await read(cloudPath(key), active, range);
      active?.throwIfAborted();
      if (bytes !== undefined && (!(bytes instanceof Uint8Array) || bytes.length > (range?.length ?? max)))
        throw rangeError('Cloud store returned too many bytes; obey the requested bound', 'sciviz');
      return bytes;
    },
  };
}

/** Reads object metadata and rejects non-object JSON with a coded format error. */
export async function cloudJSON(
  store: CloudStore,
  key: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  const bytes = await store.get(key, signal);
  if (!bytes) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw rangeError(`Cloud metadata ${key} is not JSON; check the object`, 'sciviz');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw rangeError(`Cloud metadata ${key} must be an object`, 'sciviz');
  return value as Record<string, unknown>;
}
