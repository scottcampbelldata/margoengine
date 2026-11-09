/**
 * Inflates a zlib stream (2 byte header, DEFLATE data, Adler-32 trailer) into exactly `size` bytes, or, with
 * `{ limit }` for data whose size is not stored, into a buffer that grows up to `limit` bytes. Throws MargoError
 * `'failed'` with a help link and specific details on malformed data, a missing or wrong Adler-32, an exact-size
 * mismatch, or output past `limit`. A limit failure reports the minimum required bytes and the byte limit, without
 * calling the file damaged. `limitHint` can name the caller's public option to increase (defaults to raising `limit`).
 * A valid preset-dictionary stream throws linked MargoError `'unsupported'` with recompression guidance.
 * `checkAdler: false` still requires the trailer but skips computing the checksum; only for callers whose container
 * already checks the compressed bytes (PNG's per-chunk CRC-32).
 */
export function inflateZlib(
  input: Uint8Array,
  size: number | { limit: number; limitHint?: string },
  checkAdler?: boolean,
): Uint8Array;

/**
 * Inflates the raw DEFLATE stream (RFC 1951, no zlib header or trailer) that starts at byte `start` of `input`, into
 * exactly `size` bytes or, with `{ limit }`, a buffer that grows up to `limit` bytes. Returns the bytes and `end`, the
 * position of the first byte after the final block, so a container (gzip, deflated DICOM) can check what follows.
 * Throws linked MargoError `'failed'` on malformed data, a stream that ends early, or output of another size.
 * Limit errors report the minimum required bytes and limit; `limitHint` names how the caller can raise it.
 */
export function inflateRaw(
  input: Uint8Array,
  start: number,
  size: number | { limit: number; limitHint?: string },
): { output: Uint8Array; end: number };
