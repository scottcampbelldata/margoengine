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
  /** Largest response body, in bytes. Default 32 MiB. */
  maxBytes?: number;
}

const MAX_BYTES = 32 * 1024 * 1024,
  MAX_ASSETS = 10_000;

/**
 * Resolve `assetUrl` against `indexUrl`. An absolute asset URL is kept. A protocol-relative asset
 * (`//host/path`) keeps its host. A relative index is resolved against `documentBase` when that base is
 * absolute (the page URL, or the fetch `Response.url`). With no absolute base, only the path is returned
 * and no origin is invented.
 */
export function resolveLibraryUrl(indexUrl: string, assetUrl: string, documentBase?: string): string {
  if (typeof indexUrl !== 'string' || !indexUrl) throw new TypeError('Library index URL must be a non-empty string');
  if (typeof assetUrl !== 'string' || !assetUrl) throw new TypeError('Library asset URL must be a non-empty string');
  if (hasScheme(assetUrl)) return assetUrl;
  const base = absoluteBase(indexUrl, documentBase);
  if (assetUrl.startsWith('//')) return base ? new URL(assetUrl, base).href : assetUrl;
  if (base) return new URL(assetUrl, base).href;
  const resolved = new URL(assetUrl, new URL(indexUrl, 'https://library.invalid/'));
  if (resolved.host !== 'library.invalid') return assetUrl;
  return resolved.pathname + resolved.search + resolved.hash;
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
    throw new TypeError('Library index has no assets array');
  if (json.version !== 1) throw new RangeError(`Library index version ${String(json.version)} is not 1`);
  if (json.assets.length > MAX_ASSETS) throw new RangeError(`Library index lists more than ${MAX_ASSETS} assets`);
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
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const res = await (options.fetch ?? fetch)(entry.url, { signal: options.signal });
  if (!res.ok) throw new MargoError('failed', `Library asset ${entry.id} returned ${res.status}; check its URL`);
  return limitedBuffer(res, maxBytes, entry.url);
}

function checkAsset(value: unknown, index: number, indexUrl: string): LibraryEntry {
  if (!value || typeof value !== 'object') throw new TypeError(`Library asset ${index} is not an object`);
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
  const res = await (options.fetch ?? fetch)(url, { signal: options.signal });
  if (!res.ok) throw new MargoError('failed', `Library index ${url} returned ${res.status}; check the URL`);
  const bytes = await limitedBuffer(res, options.maxBytes ?? MAX_BYTES, url);
  const base = hasScheme(res.url) ? res.url : url;
  return { json: JSON.parse(new TextDecoder().decode(bytes)), base };
}

async function limitedBuffer(res: Response, maxBytes: number, url: string): Promise<ArrayBuffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new RangeError(`Library response ${url} is ${declared} bytes, over ${maxBytes}`);
  // Without Content-Length the body is buffered, then rejected. That is not a streaming allocation ceiling.
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > maxBytes)
    throw new RangeError(`Library response ${url} is ${bytes.byteLength} bytes, over ${maxBytes}`);
  return bytes;
}

function absoluteBase(indexUrl: string, documentBase?: string): string | undefined {
  if (hasScheme(indexUrl)) return indexUrl;
  if (documentBase && hasScheme(documentBase)) return new URL(indexUrl, documentBase).href;
  return undefined;
}

function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}
