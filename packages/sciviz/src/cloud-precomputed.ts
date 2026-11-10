import { rangeError, fault } from '../../shared/errors.js';
import type { CloudStore } from './cloud-store.js';
import { decodeCloudCodec } from './cloud-codecs.js';

const bad = (why: string) => rangeError(`Precomputed shard: ${why}; check the source metadata and index`, 'sciviz');
type Metadata = Record<string, unknown>;

/** Expands the documented packed label lookup representation without losing uint64 label bytes. */
export function segmentationBytes(
  input: Uint8Array,
  dims: number[],
  block: number[],
  channels: number,
  sampleBytes: number,
  max: number,
): Uint8Array {
  const count = dims.reduce((a, b) => a * b, channels);
  if (![4, 8].includes(sampleBytes) || count * sampleBytes > max || input.length < channels * 4 || input.length % 4)
    throw bad('invalid compressed segmentation sizes');
  const v = new DataView(input.buffer, input.byteOffset, input.byteLength),
    output = new Uint8Array(count * sampleBytes);
  const grid = dims.map((n, d) => Math.ceil(n / block[d]));
  const word = (at: number) => {
    if (!Number.isSafeInteger(at) || at < 0 || at + 4 > input.length)
      throw bad('truncated compressed segmentation word');
    return v.getUint32(at, true);
  };
  if (word(0) !== channels) throw bad('first channel offset must equal channel count');
  for (let c = 0; c < channels; c++) {
    const base = word(c * 4) * 4;
    for (let z = 0; z < dims[2]; z++)
      for (let y = 0; y < dims[1]; y++)
        for (let x = 0; x < dims[0]; x++) {
          const b = [x, y, z].map((n, d) => Math.floor(n / block[d]));
          const header = base + 8 * (b[0] + grid[0] * (b[1] + grid[1] * b[2]));
          const first = word(header),
            bits = first >>> 24;
          if (![0, 1, 2, 4, 8, 16, 32].includes(bits)) throw bad('invalid compressed segmentation bit count');
          const local = (x % block[0]) + block[0] * ((y % block[1]) + block[1] * (z % block[2]));
          const bit = local * bits,
            values = word(header + 4) * 4;
          const label = bits
            ? (word(base + values + Math.floor(bit / 32) * 4) >>> (bit % 32)) &
              (bits === 32 ? 0xffffffff : 2 ** bits - 1)
            : 0;
          const at = base + (first & 0xffffff) * 4 + (label >>> 0) * sampleBytes;
          if (at < base || at + sampleBytes > input.length) throw bad('compressed segmentation table exceeds payload');
          const dst = (x + dims[0] * (y + dims[1] * (z + dims[2] * c))) * sampleBytes;
          output.set(input.subarray(at, at + sampleBytes), dst);
        }
  }
  return output;
}

/** Retrieves one compressed-Morton-keyed volume chunk from the two-level precomputed shard index. */
export async function precomputedChunk(
  store: CloudStore,
  prefix: string,
  metadata: Metadata,
  cell: number[],
  grid: number[],
  max: number,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  const shift = Number(metadata.preshift_bits),
    miniBits = Number(metadata.minishard_bits),
    shardBits = Number(metadata.shard_bits);
  if (
    metadata['@type'] !== 'neuroglancer_uint64_sharded_v1' ||
    [shift, miniBits, shardBits].some((n) => !Number.isInteger(n) || n < 0 || n > 64) ||
    miniBits + shardBits > 64 ||
    miniBits > 48
  )
    throw bad('invalid sharding parameters');
  const hash = metadata.hash;
  if (hash !== 'identity')
    throw fault('unsupported', 'Precomputed hash needs an identity-hashed scale; choose that scale', 'sciviz');
  let id = 0n,
    bit = 0n;
  for (let i = 0; i < 53; i++)
    for (let d = 0; d < 3; d++)
      if (2 ** i < grid[d]) {
        if (bit >= 64n) throw bad('Morton key exceeds uint64');
        id |= ((BigInt(cell[d]) >> BigInt(i)) & 1n) << bit++;
      }
  const hashed = id >> BigInt(shift),
    mini = hashed & ((1n << BigInt(miniBits)) - 1n);
  const shard = (hashed >> BigInt(miniBits)) & ((1n << BigInt(shardBits)) - 1n);
  const key = `${prefix}/${shard.toString(16).padStart(Math.ceil(shardBits / 4), '0')}.shard`;
  const indexEnd = 16n << BigInt(miniBits);
  const safe = (n: bigint) => {
    if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) throw bad('unsafe byte offset');
    return Number(n);
  };
  const entry = await store.get(key, signal, { offset: safe(mini * 16n), length: 16 });
  if (!entry) return undefined;
  if (entry.length !== 16) throw bad('truncated shard index');
  const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength),
    start = view.getBigUint64(0, true),
    end = view.getBigUint64(8, true);
  if (end < start || end - start > BigInt(max)) throw bad('invalid minishard range');
  if (start === end) return undefined;
  const encoded = await store.get(key, signal, { offset: safe(indexEnd + start), length: safe(end - start) });
  if (!encoded || encoded.length !== Number(end - start)) throw bad('truncated minishard index');
  const index = await decodeCloudCodec(String(metadata.minishard_index_encoding ?? 'raw'), encoded, max, signal);
  if (index.length % 24) throw bad('minishard index is not 3 rows of uint64');
  const v = new DataView(index.buffer, index.byteOffset, index.byteLength),
    n = index.length / 24;
  let at = indexEnd,
    found = 0n;
  for (let i = 0; i < n; i++) {
    const delta = v.getBigUint64(i * 8, true),
      gap = v.getBigUint64((n + i) * 8, true),
      length = v.getBigUint64((2 * n + i) * 8, true);
    if ((i && delta === 0n) || found + delta >= 1n << 64n) throw bad('chunk IDs are not strictly increasing');
    found += delta;
    at += gap;
    if (found === id) {
      if (length < 1n || length > BigInt(max)) throw bad('payload exceeds maxDecodedBytes');
      const data = await store.get(key, signal, { offset: safe(at), length: safe(length) });
      if (!data || data.length !== Number(length)) throw bad('truncated chunk');
      return decodeCloudCodec(String(metadata.data_encoding ?? 'raw'), data, max, signal);
    }
    if (found > id) return undefined;
    at += length;
  }
  return undefined;
}
