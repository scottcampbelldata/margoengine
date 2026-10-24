/**
 * Inflates a zlib stream (2 byte header, DEFLATE data, Adler-32 trailer) into exactly `size` bytes, or, with
 * `{ limit }` for data whose size is not stored, into a buffer that grows up to `limit` bytes. Throws MargoError
 * `'failed'` on malformed data, a missing or wrong Adler-32, or when the stream does not produce exactly `size` bytes.
 * `checkAdler: false` still requires the trailer but skips computing the checksum; only for callers whose container
 * already checks the compressed bytes (PNG's per-chunk CRC-32).
 */
export function inflateZlib(input: Uint8Array, size: number | { limit: number }, checkAdler?: boolean): Uint8Array;
