/** Options for {@link decompressZstd}. */
export interface ZstdOptions {
  /** Aborts decoding between blocks; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Largest total output in bytes; more throws a RangeError. Default 268,435,456 (256 MiB). */
  maxOutputSize?: number;
  /** Largest frame window in bytes a frame may declare; more throws a RangeError. Default 134,217,728 (128 MiB). */
  maxWindowSize?: number;
}

/**
 * Decompresses Zstandard data (RFC 8878): one or more frames, skippable frames skipped, content checksums verified.
 * Dictionaries are not supported.
 * @throws TypeError when `input` is not bytes; RangeError for damaged or truncated data, a failed checksum, a frame
 * window above `maxWindowSize` or output above `maxOutputSize`; MargoError `unsupported` for a frame that needs a
 * dictionary.
 * @example
 * const bytes = await decompressZstd(compressed, { maxOutputSize: 1 << 24 });
 */
export function decompressZstd(input: Uint8Array, options?: ZstdOptions): Promise<Uint8Array<ArrayBuffer>>;
