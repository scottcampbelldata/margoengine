// The Zarr reader's lazy door to the cloud codecs. formats.ts loads this module with import() for Blosc and Zstandard
// chunks, while the ./omezarr entry imports cloud-codecs.ts statically (it re-exports decodeBlosc and
// decodeCloudCodec); a separate door keeps any module from importing cloud-codecs.js both ways, so the import() still
// splits for apps that link both entries (tests/dist-dynamic-imports.test.js).
import { decodeBlosc, decodeCloudCodec } from './cloud-codecs.js';

/** Decodes one Blosc or Zstandard Zarr chunk to at most `maxBytes`. */
export const decodeZarrChunk = (
  name: 'blosc' | 'zstd',
  bytes: Uint8Array,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> =>
  name === 'blosc' ? decodeBlosc(bytes, maxBytes, signal) : decodeCloudCodec('zstd', bytes, maxBytes, signal);
