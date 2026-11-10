import { AssetCache, type AssetCacheOptions } from './index.js';

/** Content and decoder identity. Change variant when decoder options or attribute mappings change. */
export interface DecodedAssetKey {
  /** SHA-256 hex of the encoded source bytes. */
  sourceHash: string;
  /** The complete device output format, including sRGB/HDR, or the geometry layout name. */
  deviceFormat: string;
  /** Decoder identity and revision, for example 'basis-1.60' or 'draco-1.5'. */
  decoder: string;
  /** Stable decoder-options identity. Default ''. */
  variant?: string;
}

/** Decoded storage uses the same limits, persistence and eviction as AssetCache, without a network fallback. */
export type DecodedAssetCacheOptions = Omit<AssetCacheOptions, 'fetch' | 'keys' | 'freshness'>;

// Native Blob copies the array bytes; JavaScript only walks the small result metadata, never individual samples.
const arrays = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView,
};
type Node = [string, unknown];
const identity = ({ sourceHash, deviceFormat, decoder, variant = '' }: DecodedAssetKey): string => {
  if (
    typeof sourceHash !== 'string' ||
    !/^[a-f\d]{64}$/i.test(sourceHash) ||
    typeof deviceFormat !== 'string' ||
    !deviceFormat ||
    typeof decoder !== 'string' ||
    !decoder ||
    typeof variant !== 'string'
  )
    throw new TypeError(
      'Decoded cache needs a SHA-256 sourceHash, nonempty deviceFormat and decoder; set variant for decoder options',
    );
  return `https://decoded.margo.invalid/${encodeURIComponent(JSON.stringify([sourceHash.toLowerCase(), deviceFormat, decoder, variant]))}`;
};

function pack(value: unknown): Blob {
  const buffers: BlobPart[] = [],
    active = new Set<object>();
  let offset = 0;
  const visit = (value: unknown): Node => {
    if (value === undefined) return ['undefined', null];
    if (
      value === null ||
      ['string', 'boolean'].includes(typeof value) ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      return ['scalar', value];
    if (typeof value !== 'object' || value === null || active.has(value))
      throw new TypeError(
        'Decoded results must be acyclic plain records, arrays, finite scalars and binary arrays; remove unsupported values',
      );
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const name = value instanceof ArrayBuffer ? 'ArrayBuffer' : Object.prototype.toString.call(value).slice(8, -1);
      if (name !== 'ArrayBuffer' && !Object.hasOwn(arrays, name))
        throw new TypeError('Use a supported numeric typed array for decoded data');
      const bytes =
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const start = offset;
      offset += bytes.byteLength;
      buffers.push(new Blob([bytes as Uint8Array<ArrayBuffer>]));
      return [name, [start, bytes.byteLength]];
    }
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new TypeError('Use plain records for decoded metadata; class instances cannot be cached');
    active.add(value);
    const result: Node = Array.isArray(value)
      ? ['array', value.map(visit)]
      : ['object', Object.entries(value).map(([key, item]) => [key, visit(item)])];
    active.delete(value);
    return result;
  };
  const metadata = new TextEncoder().encode(JSON.stringify(visit(value))),
    header = new ArrayBuffer(4);
  new DataView(header).setUint32(0, metadata.byteLength, true);
  return new Blob([header, metadata, ...buffers]);
}

function unpack(buffer: ArrayBuffer): unknown {
  const length = new DataView(buffer).getUint32(0, true),
    start = 4 + length;
  if (start > buffer.byteLength) throw new TypeError('Decoded cache metadata is truncated; decode the source again');
  const visit = ([kind, data]: Node): unknown => {
    if (kind === 'scalar') return data;
    if (kind === 'undefined') return undefined;
    if (kind === 'array') return (data as Node[]).map(visit);
    if (kind === 'object')
      return Object.fromEntries((data as [string, Node][]).map(([key, value]) => [key, visit(value)]));
    const [offset, size] = data as number[];
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      start + offset + size > buffer.byteLength
    )
      throw new TypeError('Decoded cache array is truncated; decode the source again');
    const bytes = buffer.slice(start + offset, start + offset + size);
    if (kind === 'ArrayBuffer') return bytes;
    if (!Object.hasOwn(arrays, kind))
      throw new TypeError('Decoded cache array type is unknown; decode the source again');
    const Constructor: new (buffer: ArrayBuffer) => ArrayBufferView = arrays[kind as keyof typeof arrays];
    return new Constructor(bytes);
  };
  return visit(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buffer, 4, length))));
}

/**
 * Persistent decoded KTX2 mip/Draco array cache keyed by source SHA-256, device format and decoder revision/options.
 * Stores plain result metadata and exact typed-array bytes; imports no decoder or GPU code. Storage is best effort.
 */
export class DecodedAssetCache extends AssetCache {
  constructor(options: DecodedAssetCacheOptions = {}) {
    super({
      ...options,
      name: options.name ?? 'margo-decoded-assets',
      fetch: async () => new Response(null, { status: 404 }),
    });
  }

  /** Reads an independent result copy, or undefined on a miss, corrupt record or unavailable storage. */
  async get<T = unknown>(key: DecodedAssetKey, { signal }: { signal?: AbortSignal } = {}): Promise<T | undefined> {
    signal?.throwIfAborted();
    const url = identity(key),
      response = await this.fetch(url, { signal });
    if (!response.ok) return undefined;
    const bytes = await response.arrayBuffer();
    signal?.throwIfAborted();
    try {
      return unpack(bytes) as T;
    } catch {
      this.stats.errors++;
      await this.delete(url);
      return undefined;
    }
  }

  /** Stores a complete independent copy and waits for writes. Invalid payloads reject; quota failures count in stats.errors. */
  async set(key: DecodedAssetKey, value: unknown, { signal }: { signal?: AbortSignal } = {}): Promise<void> {
    signal?.throwIfAborted();
    if (value === undefined)
      throw new TypeError('Use a defined decoded result; undefined is reserved for cache misses');
    const url = identity(key),
      body = pack(value);
    signal?.throwIfAborted();
    await super.keep(
      new Request(url, { signal }),
      url,
      new Response(body, { headers: { 'cache-control': 'max-age=3153600000' } }),
      null,
      Date.now(),
    );
    await this.flush();
  }

  /** Deletes the stored result for precisely this content, format, revision and variant. */
  async remove(key: DecodedAssetKey): Promise<void> {
    await this.delete(identity(key));
  }

  /** Returns stored data or decodes and persists it. The callback receives the same optional cancellation signal. */
  async getOrDecode<T>(
    key: DecodedAssetKey,
    decode: (signal?: AbortSignal) => Promise<T>,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const hit = await this.get<T>(key, { signal });
    if (hit !== undefined) return hit;
    const result = await decode(signal);
    signal?.throwIfAborted();
    await this.set(key, result, { signal });
    return result;
  }
}
