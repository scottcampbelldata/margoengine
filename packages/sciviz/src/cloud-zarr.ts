import { fault, rangeError } from '../../shared/errors.js';
import { openZarr, type ZarrArray, type ZarrOptions, type ZarrStore } from './formats.js';
import {
  cloudJSON,
  cloudPath,
  cloudStore,
  type CloudInput,
  type CloudStore,
  type CloudStoreOptions,
} from './cloud-store.js';
import { cloudCRC32C, decodeCloudCodec } from './cloud-codecs.js';

type ObjectValue = Record<string, unknown>;
type Codec = { name: string; configuration?: ObjectValue };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const bad = (what: string) => rangeError(`Cloud Zarr: ${what}; check the array metadata`, 'sciviz');

/** Validates a list of dimension counts. */
export function cloudCounts(value: unknown, rank?: number): number[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    (rank !== undefined && value.length !== rank) ||
    value.some((n) => !Number.isSafeInteger(n) || n < 1)
  )
    throw bad('invalid dimension counts');
  const out = value as number[];
  if (!Number.isSafeInteger(out.reduce((a, b) => a * b, 1))) throw bad('dimension product exceeds safe integer');
  return [...out];
}

// Zarr arrays may be rank zero (shape and chunks []): one scalar chunk keyed "c" (v3) or "0" (v2) (KB5822b).
const zarrCounts = (value: unknown, rank?: number) =>
  Array.isArray(value) && !value.length && !rank ? [] : cloudCounts(value, rank);

/** Cloud codec/shard bounds plus the standard Zarr opening options. */
export interface CloudZarrOptions extends CloudStoreOptions, ZarrOptions {
  /** Largest decoded chunk or index. Default 64 MiB. */
  readonly maxDecodedBytes?: number;
}

async function decodeChain(input: Uint8Array, codecs: Codec[], max: number, signal?: AbortSignal): Promise<Uint8Array> {
  let out = input;
  for (const codec of [...codecs].reverse()) {
    if (codec.name === 'bytes' || codec.name === 'transpose') continue;
    if (codec.name === 'crc32c') {
      if (out.length < 4) throw bad('truncated CRC32C');
      const n = out.length - 4,
        v = new DataView(out.buffer, out.byteOffset, out.byteLength);
      if (cloudCRC32C(out.subarray(0, n)) !== v.getUint32(n, true)) throw bad('CRC32C mismatch');
      out = out.subarray(0, n);
    } else out = await decodeCloudCodec(codec.name, out, max, signal);
  }
  return out;
}

/**
 * A virtual uncompressed Zarr store. Feed it to the existing openZarr reader to share its typed ROI reads.
 * Shards are addressed by an index Range and a payload Range; only requested inner chunks are decoded.
 */
export async function cloudZarrStore(input: CloudInput, path = '', options: CloudZarrOptions = {}): Promise<ZarrStore> {
  const store = cloudStore(input, options),
    prefix = cloudPath(path),
    root = prefix ? `${prefix}/` : '';
  const max = options.maxDecodedBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(max) || max < 1 || max > 2 ** 29) throw bad('invalid maxDecodedBytes');
  const v3 = await cloudJSON(store, `${root}zarr.json`, options.signal);
  const v2 = v3 ? undefined : await cloudJSON(store, `${root}.zarray`, options.signal);
  if (!v2 && !v3) throw bad(`no array at ${root || '/'}`);
  const meta = structuredClone(v3 ?? v2!);
  let codecs: Codec[], shard: ObjectValue | undefined, chunks: number[], outer: number[];
  let keyIndex: (key: string) => number[];
  let shardKey: (index: number[]) => string;
  if (v3) {
    const grid = meta.chunk_grid as { configuration: { chunk_shape: number[] } };
    outer = zarrCounts(grid?.configuration?.chunk_shape);
    const list = meta.codecs as Codec[];
    if (!Array.isArray(list)) throw bad('missing codec list');
    const sharding = list.find((c) => c.name === 'sharding_indexed');
    if (sharding) {
      if (list.length !== 1) throw bad('sharding must be the outer codec');
      shard = sharding.configuration;
      chunks = zarrCounts(shard?.chunk_shape, outer.length);
      if (outer.some((n, i) => n % chunks[i])) throw bad('inner chunks do not divide shard shape');
      codecs = shard!.codecs as Codec[];
      grid.configuration.chunk_shape = chunks;
    } else {
      chunks = outer;
      codecs = list;
    }
    const encoding = meta.chunk_key_encoding as { name: string; configuration?: { separator?: string } };
    const separator = encoding?.configuration?.separator ?? (encoding?.name === 'v2' ? '.' : '/');
    if (!['default', 'v2'].includes(encoding?.name) || !['.', '/'].includes(separator))
      throw bad('invalid chunk key encoding');
    const lead = encoding.name === 'default' ? ['c'] : [];
    keyIndex = (key) => {
      const parts = key.split(separator);
      if (lead.length && parts.shift() !== 'c') throw bad('invalid chunk key');
      const index = parts.map(Number);
      if (index.length !== chunks.length || index.some((n) => !Number.isSafeInteger(n) || n < 0))
        throw bad('invalid chunk coordinates');
      return index;
    };
    shardKey = (index) => root + [...lead, ...index].join(separator);
    meta.codecs = codecs.filter((c) => ['bytes', 'transpose'].includes(c.name));
  } else {
    chunks = outer = zarrCounts(meta.chunks);
    const compressor = meta.compressor as { id?: string } | null;
    codecs = compressor ? [{ name: String(compressor.id), configuration: compressor as ObjectValue }] : [];
    meta.compressor = null;
    keyIndex = () => [];
    shardKey = () => '';
  }
  if (!Array.isArray(codecs) || codecs.some((c) => !c || typeof c.name !== 'string'))
    throw bad('invalid inner codec list');
  const indexCodecs = shard?.index_codecs as Codec[] | undefined;
  const perShard = outer.map((n, i) => n / chunks[i]);
  const indexCount = perShard.reduce((a, b) => a * b, 1);
  const indexBytes = indexCount * 16;
  const indexes = new Map<string, Uint8Array>();
  const virtual = async (key: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (key === `${root}${v3 ? 'zarr.json' : '.zarray'}`) return bytes(meta);
    if (!key.startsWith(root) || key.slice(root.length).startsWith('.')) return store.get(key, signal);
    if (!shard) {
      const encoded = await store.get(key, signal);
      return encoded ? decodeChain(encoded, codecs, max, signal) : undefined;
    }
    if (!indexCodecs || indexCodecs[0]?.name !== 'bytes' || indexCodecs.some((c, i) => i > 0 && c.name !== 'crc32c'))
      throw bad('index requires bytes and optional CRC32C');
    const location = shard.index_location ?? 'end';
    if (location !== 'start' && location !== 'end') throw bad('invalid index_location');
    const encodedSize = indexBytes + (indexCodecs.length - 1) * 4;
    if (!Number.isSafeInteger(encodedSize) || encodedSize > max) throw bad('shard index exceeds maxDecodedBytes');
    const at = keyIndex(key.slice(root.length)),
      outerAt = at.map((n, i) => Math.floor(n / perShard[i]));
    const objectKey = shardKey(outerAt);
    let index = indexes.get(objectKey);
    if (!index) {
      const encoded = await store.get(objectKey, signal, {
        offset: location === 'end' ? -encodedSize : 0,
        length: encodedSize,
      });
      if (!encoded) return undefined;
      index = await decodeChain(encoded, indexCodecs, max, signal);
      if (index.length !== indexBytes) throw bad('shard index size differs');
      // Bounded LRU-free metadata cache: at most 16 indexes, no cached payloads.
      while (indexes.size >= 16) indexes.delete(indexes.keys().next().value!);
      indexes.set(objectKey, index);
    }
    let slot = 0;
    for (let d = 0; d < at.length; d++) slot = slot * perShard[d] + (at[d] % perShard[d]);
    const endian = indexCodecs[0].configuration?.endian;
    if (endian !== 'little' && endian !== 'big') throw bad('index bytes needs endian');
    const view = new DataView(index.buffer, index.byteOffset, index.byteLength);
    const offset = view.getBigUint64(slot * 16, endian === 'little'),
      length = view.getBigUint64(slot * 16 + 8, endian === 'little');
    const absent = (1n << 64n) - 1n;
    if (offset === absent && length === absent) return undefined;
    if (
      offset > BigInt(Number.MAX_SAFE_INTEGER) ||
      length > BigInt(options.maxBytes ?? 64 * 1024 * 1024) ||
      length === 0n ||
      (location === 'start' && offset < BigInt(encodedSize))
    )
      throw bad('invalid shard payload range');
    const payload = await store.get(objectKey, signal, { offset: Number(offset), length: Number(length) });
    if (!payload || payload.length !== Number(length)) throw bad('truncated shard payload');
    return decodeChain(payload, codecs, max, signal);
  };
  return virtual;
}

/** Opens regular or sharded v2/v3 arrays, adding clean-room Blosc, zstd and LZ4 to openZarr's codecs. */
export async function openCloudZarr(input: CloudInput, path = '', options: CloudZarrOptions = {}): Promise<ZarrArray> {
  const store = await cloudZarrStore(input, path, options);
  return openZarr(store, path, options);
}

/** A required metadata object. */
export async function requireCloudJSON(store: CloudStore, key: string, signal?: AbortSignal): Promise<ObjectValue> {
  const value = await cloudJSON(store, key, signal);
  if (!value) throw fault('failed', `Missing cloud metadata ${key}; check the source path`, 'sciviz');
  return value;
}
