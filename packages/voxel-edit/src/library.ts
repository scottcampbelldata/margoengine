// Asset library client: list and fetch .vox packs from a JSON index.
import { MargoError } from '@margoengine/math/errors';

/** One entry in a library index. */
export interface LibraryEntry {
  /** Stable id. */
  id: string;
  /** Display name. */
  name: string;
  /** URL of the .vox file, absolute or resolved against the index URL. */
  url: string;
  /** Optional author. */
  author?: string;
  /** Optional tags. */
  tags?: string[];
  /** Optional preview image URL. */
  preview?: string;
}

/** A library index: a JSON document listing assets. */
export interface LibraryIndex {
  /** Index format version. Currently 1. */
  version: number;
  /** Assets. */
  assets: LibraryEntry[];
}

/** Options of {@link fetchLibrary} and {@link fetchAsset}. */
export interface LibraryFetchOptions {
  /** Fetch for the index and assets, for example an AssetCache's or a LoadingManager's `fetch`. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Aborts the request. */
  signal?: AbortSignal;
  /** Largest response body, in bytes; reading stops there. Default 32 MiB. */
  maxBytes?: number;
}

const MAX_BYTES = 32 * 1024 * 1024,
  MAX_ASSETS = 10_000,
  STAND_IN = 'https://library.invalid/',
  SEGMENT = 'margo-library-base',
  DEPTH = 32,
  DEEP = `${SEGMENT}/`.repeat(DEPTH);

/**
 * Resolve `assetUrl` against `indexUrl`. An absolute asset URL is kept. A protocol-relative asset
 * (`//host/path`) keeps its host. A relative index is resolved against `documentBase` when that base is
 * absolute (the page URL, or the fetch `Response.url`). With no absolute base no origin is invented: a root-path
 * index (`/library/index.json`) gives a root path, a protocol-relative one a protocol-relative URL, and a relative
 * one (`library/index.json`) a URL relative to the same place (`library/tree.vox`).
 */
export function resolveLibraryUrl(indexUrl: string, assetUrl: string, documentBase?: string): string {
  if (typeof indexUrl !== 'string' || !indexUrl) throw new TypeError('Library index URL must be a non-empty string');
  if (typeof assetUrl !== 'string' || !assetUrl) throw new TypeError('Library asset URL must be a non-empty string');
  if (hasScheme(assetUrl)) return assetUrl;
  const base = absoluteBase(indexUrl, documentBase);
  if (assetUrl.startsWith('//')) return base ? new URL(assetUrl, base).href : assetUrl;
  if (base) return new URL(assetUrl, base).href;
  // No absolute base: resolve on a stand-in origin, then give the result back in the index URL's own form (root path,
  // protocol-relative or relative to the same place the index is relative to).
  const rooted = indexUrl.startsWith('/'),
    resolved = new URL(assetUrl, new URL(indexUrl, rooted ? STAND_IN : STAND_IN + DEEP)),
    tail = resolved.search + resolved.hash;
  if (indexUrl.startsWith('//')) return `//${resolved.host}${resolved.pathname}${tail}`;
  if (rooted) return resolved.pathname + tail;
  const rest = resolved.pathname.slice(1).split('/');
  let ups = DEPTH;
  while (ups && rest[0] === SEGMENT) {
    rest.shift();
    ups--;
  }
  return '../'.repeat(ups) + rest.join('/') + tail;
}

/**
 * Fetch a library index and resolve asset URLs against the index URL.
 * @throws MargoError `failed` on an HTTP error status; TypeError or RangeError on a bad document or a body over
 * `maxBytes`; the fetch's own error when the request is aborted.
 */
export async function fetchLibrary(indexUrl: string, options: LibraryFetchOptions = {}): Promise<LibraryIndex> {
  const loaded = await readJson(indexUrl, options);
  const json = loaded.json as LibraryIndex;
  if (!json || typeof json !== 'object' || !Array.isArray(json.assets))
    throw new TypeError('Library index has no assets array; the index must be {version: 1, assets: [...]}');
  if (json.version !== 1)
    throw new RangeError(`Library index version ${String(json.version)} is not 1; use a version 1 index`);
  if (json.assets.length > MAX_ASSETS)
    throw new RangeError(`Library index lists more than ${MAX_ASSETS} assets; split the library into several indexes`);
  return {
    version: 1,
    assets: json.assets.map((asset, index) => checkAsset(asset, index, loaded.base)),
  };
}

/**
 * Fetch one asset's bytes.
 * @throws MargoError `failed` on an HTTP error status; RangeError when the body exceeds `maxBytes`.
 */
export async function fetchAsset(entry: LibraryEntry, options: LibraryFetchOptions = {}): Promise<ArrayBuffer> {
  const maxBytes = byteLimit(options);
  const res = await (options.fetch ?? fetch)(entry.url, { signal: options.signal });
  if (!res.ok) throw new MargoError('failed', `Library asset ${entry.id} returned ${res.status}; check its URL`);
  return limitedBuffer(res, maxBytes, entry.url);
}

function checkAsset(value: unknown, index: number, indexUrl: string): LibraryEntry {
  if (!value || typeof value !== 'object')
    throw new TypeError(`Library asset ${index} is not an object; list each asset as {id, ...}`);
  const asset = value as LibraryEntry;
  if (typeof asset.id !== 'string' || !asset.id) throw new TypeError(`Library asset ${index} needs a string id`);
  if (typeof asset.name !== 'string' || !asset.name) throw new TypeError(`Library asset ${index} needs a string name`);
  if (typeof asset.url !== 'string' || !asset.url) throw new TypeError(`Library asset ${index} needs a string url`);
  return {
    id: asset.id,
    name: asset.name,
    url: resolveLibraryUrl(indexUrl, asset.url),
    ...(typeof asset.author === 'string' ? { author: asset.author } : {}),
    ...(Array.isArray(asset.tags) ? { tags: asset.tags.filter((tag) => typeof tag === 'string') } : {}),
    ...(typeof asset.preview === 'string' ? { preview: resolveLibraryUrl(indexUrl, asset.preview) } : {}),
  };
}

async function readJson(url: string, options: LibraryFetchOptions): Promise<{ json: unknown; base: string }> {
  const maxBytes = byteLimit(options),
    res = await (options.fetch ?? fetch)(url, { signal: options.signal });
  if (!res.ok) throw new MargoError('failed', `Library index ${url} returned ${res.status}; check the URL`);
  const bytes = await limitedBuffer(res, maxBytes, url);
  const base = hasScheme(res.url) ? res.url : url;
  return { json: JSON.parse(new TextDecoder().decode(bytes)), base };
}

function byteLimit(options: LibraryFetchOptions): number {
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError(`Library maxBytes is ${maxBytes}; pass a whole number of bytes, 0 or more`);
  return maxBytes;
}

async function limitedBuffer(res: Response, maxBytes: number, url: string): Promise<ArrayBuffer> {
  const declared = Number(res.headers.get('content-length')),
    over = (bytes: number) =>
      new RangeError(
        `Library response ${url} is ${bytes} bytes, over ${maxBytes}; raise maxBytes or serve a smaller file`,
      );
  if (Number.isFinite(declared) && declared > maxBytes) throw over(declared);
  if (!res.body) {
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > maxBytes) throw over(bytes.byteLength);
    return bytes;
  }
  // Read in chunks and stop at the limit, so a body without Content-Length (or one that lies) is never buffered past it.
  const reader = res.body.getReader(),
    chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw over(total);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out.buffer;
}

function absoluteBase(indexUrl: string, documentBase?: string): string | undefined {
  if (hasScheme(indexUrl)) return indexUrl;
  if (documentBase && hasScheme(documentBase)) return new URL(indexUrl, documentBase).href;
  return undefined;
}

function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}
