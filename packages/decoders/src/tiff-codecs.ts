// The on-demand decoders of the TIFF reader (`@margoengine/decoders/tiff-codecs`): LZMA (34925), Zstandard (50000) and
// WebP (50001) strips and tiles, each loaded with import() only when a page of the file uses its code, so the TIFF
// entry and the readers that bundle it (the FBX worker) never carry them.
import type { TIFFCodecs } from './tiff.js';
import { scanTIFF } from './tiff-ifd.js';

export type { TIFFCodecs } from './tiff.js';

/** Options for {@link loadTIFFCodecs}. */
export interface TIFFCodecOptions {
  /** Aborts loading; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

/**
 * Loads the decoders a TIFF file needs for `parseTIFF` and `openTIFF`: LZMA, Zstandard and WebP, each a separate chunk
 * fetched only when a directory of `bytes` uses it (all three when `bytes` is omitted). A file without those
 * compressions loads nothing.
 *
 * @throws TypeError when `bytes` is given and is not a Uint8Array.
 * @throws MargoError `failed` when `bytes` has no valid TIFF directory chain (as `openTIFF`).
 * @example
 * const image = parseTIFF(bytes, { codecs: await loadTIFFCodecs(bytes) });
 */
export async function loadTIFFCodecs(bytes?: Uint8Array, options: TIFFCodecOptions = {}): Promise<TIFFCodecs> {
  options.signal?.throwIfAborted();
  let used = [34925, 50000, 50001];
  if (bytes !== undefined) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('loadTIFFCodecs needs Uint8Array bytes');
    used = scanTIFF(bytes).directories.map((tags) => tags.get(259)?.[0] ?? 1);
  }
  const [xz, zstd, webp] = await Promise.all([
    used.includes(34925) ? import('./xz.js') : undefined,
    used.includes(50000) ? import('../../shared/zstd.js') : undefined,
    used.includes(50001) ? import('./webp.js') : undefined,
  ]);
  options.signal?.throwIfAborted();
  return { lzma: xz?.decodeXz, zstd: zstd?.decompressZstdSync, webp: webp?.parseWebP };
}
